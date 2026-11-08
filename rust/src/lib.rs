//! Selectable 4096²/8192² sparse paper grid; output is always 4096².
//! Plate coating uses a bilinear 512² field. Paper stores wet absorption, dry reflectance, and transferred film height.
use std::ptr;
const SIM: usize = 8192;
const OUTPUT: usize = 4096;
const PREVIEW: usize = 640;
const COAT: usize = 512;
const TILE: usize = 64;
const OD_SCALE: f32 = 1024.;
const HEIGHT_SCALE: f32 = 4096.;
const SCATTER: f32 = 0.65;
const SCATTER_SCALE: f32 = 1024.;
const IMPRESSION_DEPTH: f32 = 0.08 / 255.;
type Pigment = [f32; 4];
#[derive(Clone, Copy)]
struct Pixel {
    wet: [u16; 3],
    dry: [u16; 3],
    wet_height: u16,
    dry_height: u16,
    wet_scatter: u16,
    dry_scatter: u16,
    relief: u8,
}
impl Default for Pixel {
    fn default() -> Self {
        Self {
            wet: [0; 3],
            dry: [65535; 3],
            wet_height: 0,
            dry_height: 0,
            wet_scatter: 0,
            dry_scatter: 0,
            relief: 0,
        }
    }
}
impl Pixel {
    fn height(self) -> f32 {
        (self.wet_height as f32 + self.dry_height as f32) / HEIGHT_SCALE
    }
    fn remaining_height(self) -> u16 {
        u16::MAX
            .saturating_sub(self.dry_height)
            .saturating_sub(self.wet_height)
    }
    fn reflectance(self) -> [f32; 3] {
        if self.wet_height == 0 {
            return self.dry.map(|c| c as f32 / 65535.);
        }
        [0, 1, 2].map(|c| {
            layer_over(
                self.wet[c] as f32 / OD_SCALE,
                self.wet_scatter as f32 / SCATTER_SCALE,
                self.dry[c] as f32 / 65535.,
            )
        })
    }
}
struct Engine {
    n: usize,
    m: usize,
    border: usize,
    tiles: Vec<Option<Box<[Pixel]>>>,
    source: Vec<u8>,
    coat: Vec<f32>,
    pigment: Vec<Pigment>,
    image: Vec<u8>,
    plate: Vec<u8>,
    export: Vec<u8>,
    count: u32,
    seed: u32,
    binary: bool,
    threshold: f32,
    invert: bool,
    depletion: Vec<f32>,
    paint_snapshot: Vec<f32>,
    params: Params,
    surface: Vec<f32>,
    heights: Vec<f32>,
    roller_film: Vec<f32>,
    roller_pigment: Vec<Pigment>,
    roller_width: usize,
    roller_erase: bool,
    roller_marks: Vec<u32>,
    roller_epoch: u32,
    elasticity: f32,
    dwell: f32,
    height_strength: f32,
    physics: PrintPhysics,
    has_wet: bool,
    previous_wet: Vec<Option<Box<[u16]>>>,
}

#[derive(Clone, Copy)]
struct PrintPhysics {
    compliance: f32,
    moisture: f32,
    squeeze: f32,
    dry_trapping: f32,
    wet_trapping: f32,
    dry_retention: f32,
}

impl PrintPhysics {
    fn trapping(self, substrate: Pixel) -> f32 {
        let total = substrate.wet_height as f32 + substrate.dry_height as f32;
        if total == 0. {
            return 1.;
        }
        let covered = 1. - (-substrate.height() / 0.12).exp();
        let wet_fraction = substrate.wet_height as f32 / total;
        let trapping = self.dry_trapping * (1. - wet_fraction) + self.wet_trapping * wet_fraction;
        1. + covered * (trapping - 1.)
    }
}

impl Default for PrintPhysics {
    fn default() -> Self {
        Self {
            compliance: 0.5,
            moisture: 0.,
            squeeze: 0.65,
            dry_trapping: 0.92,
            wet_trapping: 0.78,
            dry_retention: 1.,
        }
    }
}

struct Coating {
    load: f32,
    pigment: Pigment,
    // Each contribution is the amount from a coarse cell in this plate sample.
    contributions: [(usize, f32); 4],
}
#[derive(Clone, Copy, Default)]
struct Params {
    pressure: f32,
    rough: f32,
    speed: f32,
    visc: f32,
    amount: f32,
    mode: u32,
    end: f32,
    gradient: f32,
    peel: f32,
    ox: i32,
    oy: i32,
    rgb: u32,
}
// Phenomenological transfer curve: contact coverage, finite paper acceptance,
// then splitting of the remaining film. Structure follows printing transfer
// literature; coefficients are dimensionless and NOT fitted material properties.
fn transferred_film(film: f32, coverage: f32, capacity: f32, split: f32) -> f32 {
    if film <= 0. || coverage <= 0. {
        return 0.;
    }
    let b = capacity.max(0.0001);
    // Weibull-type acceptance, bounded by both the available film and capacity.
    let fixed = (b * (1. - (-(film / b).powf(1.4)).exp())).min(film);
    coverage.clamp(0., 1.) * (fixed + split.clamp(0., 1.) * (film - fixed))
}
impl Engine {
    fn new(n: usize) -> Self {
        let m = (n * 4 / 5 / 8) * 8;
        Self {
            n,
            m,
            border: (n - m) / 2,
            tiles: vec![None; (n / TILE) * (n / TILE)],
            source: vec![255; m * m],
            coat: vec![0.; COAT * COAT],
            pigment: vec![[0.; 4]; COAT * COAT],
            image: vec![0; PREVIEW * PREVIEW * 4],
            plate: vec![0; COAT * COAT * 4],
            export: Vec::new(),
            count: 0,
            seed: 41,
            binary: false,
            threshold: 150.,
            invert: false,
            depletion: vec![0.; COAT * COAT],
            paint_snapshot: Vec::new(),
            params: Params::default(),
            surface: vec![0.; COAT * COAT],
            heights: paper_heights(41),
            roller_film: vec![0.; COAT],
            roller_pigment: vec![[0.; 4]; COAT],
            roller_width: 90,
            roller_erase: false,
            roller_marks: vec![0; COAT * COAT],
            roller_epoch: 0,
            elasticity: 0.55,
            dwell: 0.4,
            height_strength: 0.6,
            physics: PrintPhysics::default(),
            has_wet: false,
            previous_wet: Vec::new(),
        }
    }
    fn pixel(&self, x: usize, y: usize) -> Pixel {
        if x >= self.n || y >= self.n {
            return Pixel::default();
        }
        let t = (y / TILE) * (self.n / TILE) + x / TILE;
        self.tiles[t]
            .as_ref()
            .map(|tile| tile[(y % TILE) * TILE + x % TILE])
            .unwrap_or_default()
    }
    fn pixel_mut(&mut self, x: usize, y: usize) -> &mut Pixel {
        let t = (y / TILE) * (self.n / TILE) + x / TILE;
        let tile = self.tiles[t]
            .get_or_insert_with(|| vec![Pixel::default(); TILE * TILE].into_boxed_slice());
        &mut tile[(y % TILE) * TILE + x % TILE]
    }
    fn new_paper(&mut self) {
        self.tiles.iter_mut().for_each(|t| *t = None);
        self.previous_wet.clear();
        self.has_wet = false;
        self.count = 0;
        self.seed = self.seed.wrapping_add(7);
        self.heights = paper_heights(self.seed);
    }
    fn dry(&mut self) {
        self.has_wet = false;
        for tile in self.tiles.iter_mut().flatten() {
            for pixel in tile.iter_mut() {
                if pixel.wet_height == 0 {
                    continue;
                }
                let reflectance = pixel.reflectance();
                for c in 0..3 {
                    pixel.dry[c] = (reflectance[c] * 65535.).round() as u16;
                    pixel.wet[c] = 0;
                }
                let retained =
                    (pixel.wet_height as f32 * self.physics.dry_retention).round() as u16;
                pixel.dry_height = pixel.dry_height.saturating_add(retained);
                pixel.dry_scatter = pixel.dry_scatter.saturating_add(pixel.wet_scatter);
                pixel.wet_height = 0;
                pixel.wet_scatter = 0;
            }
        }
    }
    fn mask(&self, x: i32, y: i32) -> f32 {
        if x < 0 || y < 0 || x >= self.m as i32 || y >= self.m as i32 {
            return 0.;
        }
        let value = self.source[y as usize * self.m + x as usize] as f32;
        if self.binary {
            return if (value < self.threshold) ^ self.invert {
                1.
            } else {
                0.
            };
        }
        let density = ((255. - value) / 255. * self.threshold / 128.).clamp(0., 1.);
        let density = if self.invert { 1. - density } else { density };
        if density <= 0. {
            return 0.;
        }
        if density >= 0.98 {
            return 1.;
        }
        let cell = self.m as f32 / 64.;
        let dx = (x as f32 + 0.5) / cell;
        let dy = (y as f32 + 0.5) / cell;
        if density >= 0.98
            || std::f32::consts::PI * ((dx.fract() - 0.5).powi(2) + (dy.fract() - 0.5).powi(2))
                < density
        {
            1.
        } else {
            0.
        }
    }
    fn coating(&self, x: i32, y: i32, params: Params, cell_area: f32) -> Coating {
        if params.mode != 2 {
            let a = params.gradient.to_radians();
            let t = ((x as f32 * a.cos() + y as f32 * a.sin())
                / ((self.m - 1) as f32 * (a.cos() + a.sin()).max(0.001)))
            .clamp(0., 1.);
            return Coating {
                load: if params.mode == 1 {
                    params.amount * (1. - t) + params.end * t
                } else {
                    params.amount
                },
                pigment: absorption(params.rgb),
                contributions: [(0, 0.); 4],
            };
        }
        let cx = (x as f32 / (self.m - 1) as f32 * (COAT - 1) as f32).clamp(0., (COAT - 1) as f32);
        let cy = (y as f32 / (self.m - 1) as f32 * (COAT - 1) as f32).clamp(0., (COAT - 1) as f32);
        let x0 = cx.floor() as usize;
        let y0 = cy.floor() as usize;
        let x1 = (x0 + 1).min(COAT - 1);
        let y1 = (y0 + 1).min(COAT - 1);
        let fx = cx - x0 as f32;
        let fy = cy - y0 as f32;
        let mut coating = Coating {
            load: 0.,
            pigment: [0.; 4],
            contributions: [
                (y0 * COAT + x0, (1. - fx) * (1. - fy)),
                (y0 * COAT + x1, fx * (1. - fy)),
                (y1 * COAT + x0, (1. - fx) * fy),
                (y1 * COAT + x1, fx * fy),
            ],
        };
        for (i, weight) in &mut coating.contributions {
            let q = if self.paint_snapshot.is_empty() {
                self.coat[*i]
            } else {
                self.paint_snapshot[*i]
            };
            *weight *= q;
            if cell_area > 0. {
                *weight = weight.min((q - self.depletion[*i]).max(0.) * cell_area);
            }
            coating.load += *weight;
            for (color, &coefficient) in coating.pigment.iter_mut().zip(&self.pigment[*i]) {
                *color += coefficient * *weight;
            }
        }
        if coating.load > 0. {
            for coefficient in &mut coating.pigment {
                *coefficient /= coating.load;
            }
        }
        coating
    }
    fn refresh_surface(&mut self) {
        for y in 0..COAT {
            for x in 0..COAT {
                let mut covered = 0.;
                for sy in 0..4 {
                    for sx in 0..4 {
                        covered += self.mask(
                            ((x as f32 + (sx as f32 + 0.5) / 4.) / COAT as f32 * self.m as f32)
                                as i32,
                            ((y as f32 + (sy as f32 + 0.5) / 4.) / COAT as f32 * self.m as f32)
                                as i32,
                        );
                    }
                }
                self.surface[y * COAT + x] = covered / 16.;
            }
        }
    }
    fn roller_load(&mut self, width: f32, amount: f32, erase: bool, rgb: u32, scattering: f32) {
        self.roller_width = width.round().clamp(16., 256.) as usize;
        self.roller_film.fill(amount.clamp(0., 1.) * 1.1);
        self.roller_pigment
            .fill(ink_pigment(rgb, SCATTER * scattering));
        self.roller_erase = erase;
    }
    fn roller_move(&mut self, x0: f32, y0: f32, x1: f32, y1: f32) {
        let dx = x1 - x0;
        let dy = y1 - y0;
        let distance = (dx * dx + dy * dy).sqrt();
        if !distance.is_finite() || distance < 0.25 {
            return;
        }
        let nx = -dy / distance;
        let ny = dx / distance;
        let steps = distance.ceil() as usize;
        self.roller_epoch = self.roller_epoch.wrapping_add(1);
        if self.roller_epoch == 0 {
            self.roller_marks.fill(0);
            self.roller_epoch = 1;
        }
        for step in 0..steps {
            let t = (step as f32 + 0.5) / steps as f32;
            for bin in 0..self.roller_width {
                let across = bin as f32 + 0.5 - self.roller_width as f32 / 2.;
                let x = (x0 + dx * t + nx * across).round() as i32;
                let y = (y0 + dy * t + ny * across).round() as i32;
                if x < 0 || y < 0 || x >= COAT as i32 || y >= COAT as i32 {
                    continue;
                }
                let k = y as usize * COAT + x as usize;
                let area = self.surface[k];
                if area == 0. || self.roller_marks[k] == self.roller_epoch {
                    continue;
                }
                self.roller_marks[k] = self.roller_epoch;
                let edge = ((self.roller_width as f32 / 2. - across.abs()) / 2.).clamp(0., 1.);
                let contact = 0.28 * edge;
                let old = self.coat[k];
                let delta = if self.roller_erase {
                    -old * contact
                } else {
                    (self.roller_film[bin] - old) * contact
                };
                let next = (old + delta).max(0.);
                if delta > 0. {
                    for c in 0..4 {
                        self.pigment[k][c] =
                            (self.pigment[k][c] * old + self.roller_pigment[bin][c] * delta) / next;
                    }
                    self.roller_film[bin] = (self.roller_film[bin] - delta * area / 64.).max(0.);
                } else if delta < 0. && !self.roller_erase {
                    let pickup = -delta * area / 64.;
                    let q = self.roller_film[bin];
                    for c in 0..4 {
                        self.roller_pigment[bin][c] = (self.roller_pigment[bin][c] * q
                            + self.pigment[k][c] * pickup)
                            / (q + pickup);
                    }
                    self.roller_film[bin] += pickup;
                }
                self.coat[k] = next;
                if next == 0. {
                    self.pigment[k] = [0.; 4];
                }
            }
        }
        self.paint_snapshot.clear();
    }
    fn paper_height(&self, x: usize, y: usize) -> f32 {
        let fx = x as f32 / (self.n - 1) as f32 * (COAT - 1) as f32;
        let fy = y as f32 / (self.n - 1) as f32 * (COAT - 1) as f32;
        let ix = fx.floor() as usize;
        let iy = fy.floor() as usize;
        let tx = fx - ix as f32;
        let ty = fy - iy as f32;
        let ix1 = (ix + 1).min(COAT - 1);
        let iy1 = (iy + 1).min(COAT - 1);
        (self.heights[iy * COAT + ix] * (1. - tx) + self.heights[iy * COAT + ix1] * tx) * (1. - ty)
            + (self.heights[iy1 * COAT + ix] * (1. - tx) + self.heights[iy1 * COAT + ix1] * tx) * ty
    }
    fn paint(&mut self, x: f32, y: f32, r: f32, strength: f32, erase: bool, rgb: u32) {
        let r = r.clamp(1., 128.);
        let pigment = absorption(rgb);
        for py in ((y - r).floor() as i32).max(0)..((y + r).ceil() as i32).min(COAT as i32) {
            for px in ((x - r).floor() as i32).max(0)..((x + r).ceil() as i32).min(COAT as i32) {
                let d = ((px as f32 - x).powi(2) + (py as f32 - y).powi(2)) / r.powi(2);
                if d > 1. {
                    continue;
                }
                let k = py as usize * COAT + px as usize;
                let old = self.coat[k];
                let w = (1. - d) * strength.clamp(0., 1.) * 0.12 * (0.8 + 0.2 * hash(px, py, 33));
                let next = (old + if erase { -3. * w } else { w }).clamp(0., 3.);
                if !erase && next > old {
                    for c in 0..4 {
                        self.pigment[k][c] =
                            (self.pigment[k][c] * old + pigment[c] * (next - old)) / next;
                    }
                }
                self.coat[k] = next;
                if next == 0. {
                    self.pigment[k] = [0.; 4];
                }
            }
        }
        self.paint_snapshot.clear();
    }
    fn clear_ink(&mut self) {
        self.coat.fill(0.);
        self.pigment.fill([0.; 4]);
        self.paint_snapshot.clear();
    }
    fn deposit(&mut self, x: i32, y: i32, mass: f32, pigment: Pigment) -> f32 {
        let n = self.n as i32;
        if mass * HEIGHT_SCALE < 1. || x < 0 || y < 0 || x >= n || y >= n {
            return 0.;
        }
        let p = self.pixel_mut(x as usize, y as usize);
        let mut accepted = mass.min(p.remaining_height() as f32 / HEIGHT_SCALE);
        for (stored, coefficient, scale) in [
            (p.wet[0], pigment[0], OD_SCALE),
            (p.wet[1], pigment[1], OD_SCALE),
            (p.wet[2], pigment[2], OD_SCALE),
            (p.wet_scatter, pigment[3], SCATTER_SCALE),
        ] {
            if coefficient > 0. {
                accepted = accepted.min((u16::MAX - stored) as f32 / (coefficient * scale));
            }
        }
        let height = (accepted * HEIGHT_SCALE).floor() as u16;
        if height == 0 {
            return 0.;
        }
        accepted = height as f32 / HEIGHT_SCALE;
        p.wet_height += height;
        for (stored, coefficient) in p.wet.iter_mut().zip(pigment) {
            *stored = stored.saturating_add((accepted * coefficient * OD_SCALE).round() as u16);
        }
        p.wet_scatter = p
            .wet_scatter
            .saturating_add((accepted * pigment[3] * SCATTER_SCALE).round() as u16);
        self.has_wet = true;
        accepted
    }

    fn begin(&mut self, p: Params) {
        self.params = p;
        self.depletion.fill(0.);
        self.paint_snapshot.clone_from(&self.coat);
        self.previous_wet.clear();
        if self.has_wet && p.pressure > 0. {
            // Keep the substrate at the start of this impression. Ink spread into a
            // later row belongs to this impression and must not alter its contact.
            self.previous_wet.extend(self.tiles.iter().map(|tile| {
                let tile = tile.as_ref()?;
                tile.iter()
                    .any(|pixel| pixel.wet_height > 0)
                    .then(|| tile.iter().map(|pixel| pixel.wet_height).collect())
            }));
        }
    }

    fn substrate_pixel(&self, x: usize, y: usize) -> Pixel {
        let mut pixel = self.pixel(x, y);
        let tile = (y / TILE) * (self.n / TILE) + x / TILE;
        pixel.wet_height = self
            .previous_wet
            .get(tile)
            .and_then(Option::as_ref)
            .map_or(0, |saved| saved[(y % TILE) * TILE + x % TILE]);
        pixel
    }
    fn rows(&mut self, start: usize, rows: usize) {
        let p = self.params;
        if p.pressure == 0. {
            return;
        }
        let scale = self.n as f32 / 640.;
        let (peel_y, peel_x) = p.peel.to_radians().sin_cos();
        let physics = self.physics;
        let softness = (0.45 + 1.1 * physics.compliance) * (1. + 0.6 * physics.moisture);
        let compression =
            1. / (1. + 1.6 * (1. + 5. * p.pressure).ln() * (0.5 + self.dwell) * softness);
        let capacity = 0.16 * (0.4 + 0.6 * p.rough) / (0.4 + p.visc);
        let cell_area = ((self.m - 1) as f32 / (COAT - 1) as f32).powi(2);
        let offset_x = self.border as i32 + (p.ox as f32 * scale).round() as i32;
        let offset_y = self.border as i32 + (p.oy as f32 * scale).round() as i32;
        let smear = p.speed * p.visc * 2. * scale;
        let smear_x = (peel_x * smear).round() as i32;
        let smear_y = (peel_y * smear).round() as i32;
        let max_y = (start + rows).min(self.m);
        for py in start..max_y {
            for px in 0..self.m {
                if self.mask(px as i32, py as i32) == 0. {
                    continue;
                }
                let x = px as i32 + offset_x;
                let y = py as i32 + offset_y;
                if x < 0 || y < 0 || x >= self.n as i32 || y >= self.n as i32 {
                    continue;
                }
                let coating = self.coating(px as i32, py as i32, p, cell_area);
                let local = coating.load;
                let pigment = coating.pigment;
                let previous = self.substrate_pixel(x as usize, y as usize);
                let height = self.paper_height(x as usize, y as usize);
                let gap = ((1. - height) * p.rough * 0.55 * compression
                    + previous.relief as f32 * IMPRESSION_DEPTH
                    - previous.height() * 0.04)
                    .max(0.);
                let closure = p.pressure * 0.16;
                let solid_contact = smooth((closure - gap + 0.025) / 0.065);
                let deformation = (p.pressure * solid_contact * 65. * softness
                    / (1. + 0.65 * local))
                    .round() as u8;
                if deformation > 0 {
                    self.pixel_mut(x as usize, y as usize).relief =
                        previous.relief.saturating_add(deformation);
                }
                if local == 0. {
                    continue;
                }
                let contact = smooth((closure + local * 0.18 - gap + 0.025) / 0.065);
                let film = local * 1.35;
                let split = (0.5 / (1. + 0.6 * p.speed + 0.15 * film)).clamp(0.15, 0.5);
                let coverage =
                    contact * (1. - (-(film / 0.125 * (1. + p.pressure * 3.)).powi(2)).exp());
                let mass =
                    transferred_film(film, coverage, capacity, split) * physics.trapping(previous);
                if mass * HEIGHT_SCALE < 1. {
                    continue;
                }
                let excess = (local - 0.5).max(0.);
                let sides = [
                    (-1, 0, -peel_x),
                    (1, 0, peel_x),
                    (0, -1, -peel_y),
                    (0, 1, peel_y),
                ]
                .map(|(dx, dy, direction)| {
                    (
                        dx,
                        dy,
                        direction,
                        self.mask(px as i32 + dx, py as i32 + dy) == 0.,
                    )
                });
                let exposed = sides.iter().filter(|side| side.3).count();
                let edge = exposed > 0;
                let spread = excess
                    * p.pressure
                    * (1. - p.visc)
                    * physics.squeeze
                    * (1. + 0.5 * physics.moisture);
                let radius = (spread * 5.).min(7.) * scale;
                let squeeze = if edge {
                    (spread * 1.4).min(0.45) * radius.min(1.)
                } else {
                    0.
                };
                let bleed = ((1. - p.visc) * p.rough * 0.08).clamp(0., 0.08);
                // Rare satellites only in excess low-viscosity ink. Most separated ink
                // stays in the print or in a connected, direction-dependent filament.
                let flick = if edge
                    && excess > 0.
                    && hash(px as i32, py as i32, self.count + 213)
                        < excess.min(1.) * p.speed * (1. - p.visc).powi(2) * 0.005
                {
                    0.03 * p.speed
                } else {
                    0.
                };
                let filament = if sides.iter().any(|side| side.3 && side.2 > 0.2) {
                    0.14 * self.elasticity * p.speed * film / (film + 0.15)
                } else {
                    0.
                };
                let mut accepted = self.deposit(
                    x,
                    y,
                    mass * (1. - bleed - flick - filament - squeeze),
                    pigment,
                );
                if squeeze > 0. {
                    let per_cell = mass * squeeze / (exposed as f32 * radius);
                    for (dx, dy, _, open) in sides {
                        if open {
                            for step in 1..=radius.ceil() as i32 {
                                let weight = (radius - (step - 1) as f32).min(1.);
                                accepted += self.deposit(
                                    x + dx * step,
                                    y + dy * step,
                                    per_cell * weight,
                                    pigment,
                                );
                            }
                        }
                    }
                }
                if bleed > 0. {
                    let direction = hash(
                        (x as f32 / scale) as i32,
                        (y as f32 / scale) as i32,
                        self.seed,
                    ) * std::f32::consts::TAU;
                    let distance = (0.2 + 1.2 * (1. - height)) * scale;
                    accepted += self.deposit(
                        x + (direction.cos() * distance).round() as i32,
                        y + (direction.sin() * distance).round() as i32,
                        mass * bleed,
                        pigment,
                    );
                }
                if filament > 0. {
                    let length =
                        (0.3 + 10. * self.elasticity * p.speed * (film / (film + 0.25))) * scale;
                    for step in 1..=6 {
                        let t = step as f32 / 6.;
                        let bend = (height - 0.5) * scale * t * t;
                        accepted += self.deposit(
                            x + (peel_x * length * t - peel_y * bend).round() as i32,
                            y + (peel_y * length * t + peel_x * bend).round() as i32,
                            mass * filament * (7 - step) as f32 / 21.,
                            pigment,
                        );
                    }
                }
                if flick > 0. {
                    let distance = (4. + hash(px as i32, py as i32, 313) * excess * 12.) * scale;
                    accepted += self.deposit(
                        x + (peel_x * distance).round() as i32,
                        y + (peel_y * distance).round() as i32,
                        mass * flick,
                        pigment,
                    );
                }
                if p.mode == 2 {
                    let depleted = accepted / (1.35 * cell_area * local);
                    for (i, contribution) in coating.contributions {
                        self.depletion[i] += depleted * contribution;
                    }
                }
                let nx = (x + smear_x).clamp(0, self.n as i32 - 1) as usize;
                let ny = (y + smear_y).clamp(0, self.n as i32 - 1) as usize;
                if accepted > 0. && (nx != x as usize || ny != y as usize) {
                    let mobility = (accepted * 0.12 * (1. - p.visc)).clamp(0., 0.1);
                    self.flow_wet(x as usize, y as usize, nx, ny, mobility);
                }
            }
        }
    }
    fn finish(&mut self) {
        if self.params.mode == 2 {
            for (k, q) in self.coat.iter_mut().enumerate() {
                *q = (*q - self.depletion[k]).max(0.);
            }
        }
        self.paint_snapshot.clear();
        self.previous_wet.clear();
        self.count += 1;
    }
    // Move a fraction of the thicker wet film together with its pigments.
    // Dry layers never migrate. Quantization is conservative in both reservoirs.
    fn flow_wet(&mut self, x: usize, y: usize, nx: usize, ny: usize, mobility: f32) {
        if x == nx && y == ny {
            return;
        }
        let a = self.pixel(x, y);
        let b = self.pixel(nx, ny);
        let (sx, sy, tx, ty, source, target) = if a.wet_height >= b.wet_height {
            (x, y, nx, ny, a, b)
        } else {
            (nx, ny, x, y, b, a)
        };
        if source.wet_height == 0 {
            return;
        }
        let mut amount = ((source.wet_height - target.wet_height) as f32 * mobility.clamp(0., 1.))
            .round()
            .min(target.remaining_height() as f32);
        if source.wet_scatter > 0 {
            amount = amount.min(
                (u16::MAX - target.wet_scatter) as f32 * source.wet_height as f32
                    / source.wet_scatter as f32,
            );
        }
        for c in 0..3 {
            if source.wet[c] > 0 {
                amount = amount.min(
                    (65535 - target.wet[c]) as f32 * source.wet_height as f32
                        / source.wet[c] as f32,
                );
            }
        }
        let amount = amount.floor() as u16;
        if amount == 0 {
            return;
        }
        let fraction = amount as f32 / source.wet_height as f32;
        for c in 0..3 {
            let delta = (source.wet[c] as f32 * fraction).round() as u16;
            self.pixel_mut(sx, sy).wet[c] -= delta;
            self.pixel_mut(tx, ty).wet[c] += delta;
        }
        let scatter = (source.wet_scatter as f32 * fraction).round() as u16;
        let source = self.pixel_mut(sx, sy);
        source.wet_height -= amount;
        source.wet_scatter -= scatter;
        let target = self.pixel_mut(tx, ty);
        target.wet_height += amount;
        target.wet_scatter += scatter;
    }
    fn shade(&self, x: usize, y: usize) -> [f32; 3] {
        let p = self.pixel(x, y);
        let left = self.pixel(x.saturating_sub(1), y);
        let above = self.pixel(x, y.saturating_sub(1));
        let scale = self.n as f32 / OUTPUT as f32;
        let slope = ((left.height() + above.height() - 2. * p.height()) * scale).clamp(-1., 1.);
        let depression =
            ((left.relief as f32 + above.relief as f32 - 2. * p.relief as f32) * scale / 255.)
                .clamp(-1., 1.);
        let shade = (0.977 + 0.025 * self.paper_height(x, y) - 0.12 * depression
            + self.height_strength * 0.18 * slope)
            .clamp(0.75, 1.12);
        let reflection = p.reflectance();
        [0, 1, 2].map(|c| [249., 245., 232.][c] * shade * reflection[c])
    }
    fn render(&mut self, size: usize, export: bool) {
        let mut bytes = if export {
            std::mem::take(&mut self.export)
        } else {
            std::mem::take(&mut self.image)
        };
        bytes.resize(size * size * 4, 0);
        let factor = self.n as f32 / size as f32;
        let samples: &[(f32, f32)] = if self.n == size {
            &[(0.5, 0.5)]
        } else {
            &[(0.25, 0.25), (0.75, 0.25), (0.25, 0.75), (0.75, 0.75)]
        };
        let weight = 1. / samples.len() as f32;
        for y in 0..size {
            for x in 0..size {
                let mut sum = [0.; 3];
                for &(fx, fy) in samples {
                    let rgb = self.shade(
                        ((x as f32 + fx) * factor).floor().min((self.n - 1) as f32) as usize,
                        ((y as f32 + fy) * factor).floor().min((self.n - 1) as f32) as usize,
                    );
                    for c in 0..3 {
                        sum[c] += rgb[c];
                    }
                }
                let k = (y * size + x) * 4;
                for c in 0..3 {
                    bytes[k + c] = (sum[c] * weight).clamp(0., 255.) as u8;
                }
                bytes[k + 3] = 255;
            }
        }
        if export {
            self.export = bytes
        } else {
            self.image = bytes
        }
    }
    fn ink_rgba(&self, x: usize, y: usize) -> [f32; 4] {
        let p = self.pixel(x, y);
        if p.height() == 0. && p.dry_scatter == 0 && p.dry == [u16::MAX; 3] {
            return [0.; 4];
        }
        let reflection = p.reflectance();
        // White-background-equivalent RGBA; alpha also represents white pigment.
        // This does not preserve spectral scattering on arbitrary backgrounds.
        let scatter = (p.wet_scatter as f32 + p.dry_scatter as f32) / SCATTER_SCALE;
        let alpha =
            (scatter / (1. + scatter)).max(1. - reflection.iter().copied().fold(1., f32::min));
        [
            reflection[0] - (1. - alpha),
            reflection[1] - (1. - alpha),
            reflection[2] - (1. - alpha),
            alpha,
        ]
    }
    fn render_transparent(&mut self, size: usize) {
        let mut bytes = std::mem::take(&mut self.export);
        bytes.resize(size * size * 4, 0);
        let factor = self.n as f32 / size as f32;
        let samples: &[(f32, f32)] = if self.n == size {
            &[(0.5, 0.5)]
        } else {
            &[(0.25, 0.25), (0.75, 0.25), (0.25, 0.75), (0.75, 0.75)]
        };
        let weight = 1. / samples.len() as f32;
        for y in 0..size {
            for x in 0..size {
                let mut sum = [0.; 4];
                for &(fx, fy) in samples {
                    let rgba = self.ink_rgba(
                        ((x as f32 + fx) * factor).floor().min((self.n - 1) as f32) as usize,
                        ((y as f32 + fy) * factor).floor().min((self.n - 1) as f32) as usize,
                    );
                    for c in 0..4 {
                        sum[c] += rgba[c] * weight;
                    }
                }
                let k = (y * size + x) * 4;
                for c in 0..3 {
                    bytes[k + c] = if sum[3] > 0. {
                        (sum[c] / sum[3] * 255.).round().clamp(0., 255.) as u8
                    } else {
                        0
                    };
                }
                bytes[k + 3] = (sum[3] * 255.).round().clamp(0., 255.) as u8;
            }
        }
        self.export = bytes;
    }
    fn update_plate(&mut self, p: Params) {
        for y in 0..COAT {
            for x in 0..COAT {
                let px = (x as f32 / (COAT - 1) as f32 * (self.m - 1) as f32).round() as i32;
                let py = (y as f32 / (COAT - 1) as f32 * (self.m - 1) as f32).round() as i32;
                let Coating { load, pigment, .. } = self.coating(px, py, p, 0.);
                let covered = self.surface[y * COAT + x];
                let opacity = (1. - (-load * 1.5).exp()) * covered;
                let bare = 188. - 90. * covered;
                let k = (y * COAT + COAT - 1 - x) * 4;
                for c in 0..3 {
                    self.plate[k + c] = (bare * (1. - opacity)
                        + 255. * layer_over(pigment[c] * 0.9, pigment[3] * 0.9, 1.) * opacity)
                        as u8;
                }
                self.plate[k + 3] = 255;
            }
        }
    }
}
fn smooth(t: f32) -> f32 {
    let t = t.clamp(0., 1.);
    t * t * (3. - 2. * t)
}
fn noise(x: f32, y: f32, seed: u32) -> f32 {
    let ix = x.floor() as i32;
    let iy = y.floor() as i32;
    let tx = smooth(x - ix as f32);
    let ty = smooth(y - iy as f32);
    (hash(ix, iy, seed) * (1. - tx) + hash(ix + 1, iy, seed) * tx) * (1. - ty)
        + (hash(ix, iy + 1, seed) * (1. - tx) + hash(ix + 1, iy + 1, seed) * tx) * ty
}
fn paper_heights(seed: u32) -> Vec<f32> {
    let mut result = vec![0.; COAT * COAT];
    for y in 0..COAT {
        for x in 0..COAT {
            let u = x as f32 * 640. / COAT as f32;
            let v = y as f32 * 640. / COAT as f32;
            result[y * COAT + x] = (0.30 * noise(u / 18., v / 18., seed)
                + 0.45 * noise(u / 2.5, v / 14., seed + 19)
                + 0.25 * noise(u / 1.6, v / 1.6, seed + 41))
            .clamp(0., 1.);
        }
    }
    result
}
// Finite homogeneous Kubelka–Munk layer, using integrated K and S.
// RGB coefficients are estimated from the picker, not measured spectra.
// Stable exponential form avoids overflow for thick or very dark films.
fn layer_over(k: f32, s: f32, bottom: f32) -> f32 {
    if s < 1e-7 {
        return bottom * (-2. * k.max(0.)).exp();
    }
    let (r, t) = if k < 1e-7 {
        (s / (1. + s), 1. / (1. + s))
    } else {
        let a = 1. + k / s;
        let b = (a * a - 1.).sqrt();
        let d = b * s;
        let e = (-2. * d).exp();
        let denom = a * (1. - e) + b * (1. + e);
        ((1. - e) / denom, 2. * b * (-d).exp() / denom)
    };
    (r + t * t * bottom / (1. - r * bottom).max(1e-7)).clamp(0., 1.)
}
fn absorption(rgb: u32) -> Pigment {
    ink_pigment(rgb, SCATTER)
}

fn ink_pigment(rgb: u32, scatter: f32) -> Pigment {
    let [r, g, b] = [rgb >> 16 & 255, rgb >> 8 & 255, rgb & 255].map(|c| {
        let r = (c as f32 / 255.).max(0.04);
        scatter * (1. - r).powi(2) / (2. * r)
    });
    [r, g, b, scatter]
}
fn hash(x: i32, y: i32, s: u32) -> f32 {
    let mut a = (x as u32).wrapping_add(17).wrapping_mul(374761393)
        ^ (y as u32).wrapping_add(31).wrapping_mul(668265263)
        ^ s.wrapping_mul(1274126177);
    a = (a ^ (a >> 13)).wrapping_mul(1274126177);
    ((a ^ (a >> 16)) as f64 / u32::MAX as f64) as f32
}
static mut ENGINE: *mut Engine = ptr::null_mut();
unsafe fn engine() -> &'static mut Engine {
    &mut *ENGINE
}
#[no_mangle]
pub extern "C" fn engine_init() {
    engine_init_resolution(SIM);
}
#[no_mangle]
pub extern "C" fn engine_init_resolution(size: usize) {
    let n = if size == 4096 { 4096 } else { SIM };
    unsafe {
        if !ENGINE.is_null() {
            drop(Box::from_raw(ENGINE));
        }
        ENGINE = Box::into_raw(Box::new(Engine::new(n)));
    }
}
#[no_mangle]
pub extern "C" fn simulation_size() -> usize {
    unsafe { engine().n }
}
#[no_mangle]
pub extern "C" fn source_size() -> usize {
    unsafe { engine().m }
}
#[no_mangle]
pub extern "C" fn output_size() -> usize {
    OUTPUT
}
#[no_mangle]
pub extern "C" fn source_ptr() -> *mut u8 {
    unsafe { engine().source.as_mut_ptr() }
}
#[no_mangle]
pub extern "C" fn coating_ptr() -> *const f32 {
    unsafe { engine().coat.as_ptr() }
}
#[no_mangle]
pub extern "C" fn surface_ptr() -> *mut f32 {
    unsafe { engine().surface.as_mut_ptr() }
}
#[no_mangle]
pub extern "C" fn pigment_ptr() -> *mut f32 {
    unsafe { engine().pigment.as_mut_ptr().cast::<f32>() }
}
#[no_mangle]
pub extern "C" fn image_ptr() -> *const u8 {
    unsafe { engine().image.as_ptr() }
}
#[no_mangle]
pub extern "C" fn plate_ptr() -> *const u8 {
    unsafe { engine().plate.as_ptr() }
}
#[no_mangle]
pub extern "C" fn export_ptr() -> *const u8 {
    unsafe { engine().export.as_ptr() }
}
#[no_mangle]
pub extern "C" fn configure_plate(binary: u32, threshold: f32, invert: u32) {
    unsafe {
        let e = engine();
        e.binary = binary != 0;
        e.threshold = threshold.clamp(0., 255.);
        e.invert = invert != 0;
    }
}
#[no_mangle]
pub extern "C" fn new_paper() {
    unsafe {
        engine().new_paper();
    }
}
#[no_mangle]
pub extern "C" fn dry_ink() {
    unsafe {
        engine().dry();
    }
}
#[no_mangle]
pub extern "C" fn clear_ink() {
    unsafe {
        engine().clear_ink();
    }
}
#[no_mangle]
pub extern "C" fn paint_ink(x: f32, y: f32, r: f32, strength: f32, erase: u32, rgb: u32) {
    unsafe {
        engine().paint(x, y, r, strength, erase != 0, rgb);
    }
}
#[no_mangle]
pub extern "C" fn update_plate(mode: u32, amount: f32, end: f32, angle: f32, rgb: u32) {
    unsafe {
        engine().update_plate(Params {
            mode,
            amount,
            end,
            gradient: angle,
            rgb,
            ..Params::default()
        });
    }
}
#[no_mangle]
pub extern "C" fn refresh_plate() {
    unsafe {
        engine().refresh_surface();
    }
}
#[no_mangle]
pub extern "C" fn roller_load(width: f32, amount: f32, erase: u32, rgb: u32, scattering: f32) {
    unsafe {
        engine().roller_load(width, amount, erase != 0, rgb, scattering.clamp(0.05, 4.));
    }
}
#[no_mangle]
pub extern "C" fn roller_move(x0: f32, y0: f32, x1: f32, y1: f32) {
    unsafe {
        engine().roller_move(x0, y0, x1, y1);
    }
}
#[no_mangle]
pub extern "C" fn configure_materials(elasticity: f32, dwell: f32, height_strength: f32) {
    unsafe {
        engine().elasticity = elasticity.clamp(0., 1.);
        engine().dwell = dwell.clamp(0., 1.);
        engine().height_strength = height_strength.clamp(0., 1.);
    }
}
#[no_mangle]
pub extern "C" fn engine_api_version() -> u32 {
    4
}

#[no_mangle]
pub extern "C" fn configure_print_physics(
    compliance: f32,
    moisture: f32,
    squeeze: f32,
    dry_trapping: f32,
    wet_trapping: f32,
    dry_retention: f32,
) {
    unsafe {
        engine().physics = PrintPhysics {
            compliance: compliance.clamp(0., 1.),
            moisture: moisture.clamp(0., 1.),
            squeeze: squeeze.clamp(0., 1.),
            dry_trapping: dry_trapping.clamp(0., 1.),
            wet_trapping: wet_trapping.clamp(0., 1.),
            dry_retention: dry_retention.clamp(0.25, 1.),
        };
    }
}

#[no_mangle]
pub extern "C" fn print_begin(
    pressure: f32,
    rough: f32,
    speed: f32,
    visc: f32,
    amount: f32,
    mode: u32,
    end: f32,
    gradient: f32,
    peel: f32,
    ox: i32,
    oy: i32,
    rgb: u32,
) {
    unsafe {
        engine().begin(Params {
            pressure: pressure.clamp(0., 1.),
            rough: rough.clamp(0., 1.),
            speed: speed.clamp(0., 1.),
            visc: visc.clamp(0., 1.),
            amount: amount.clamp(0., 1.),
            mode,
            end: end.clamp(0., 1.),
            gradient,
            peel,
            ox: ox.clamp(-100, 100),
            oy: oy.clamp(-100, 100),
            rgb,
        });
    }
}
#[no_mangle]
pub extern "C" fn print_rows(start: usize, rows: usize) {
    unsafe {
        engine().rows(start, rows);
    }
}
#[no_mangle]
pub extern "C" fn print_finish() {
    unsafe {
        engine().finish();
    }
}
#[no_mangle]
pub extern "C" fn render_preview() {
    unsafe {
        engine().render(PREVIEW, false);
    }
}
#[no_mangle]
pub extern "C" fn render_export_transparent() {
    unsafe {
        engine().render_transparent(OUTPUT);
    }
}
#[no_mangle]
pub extern "C" fn render_export() {
    unsafe {
        engine().render(OUTPUT, true);
    }
}
#[no_mangle]
pub extern "C" fn impression_count() -> u32 {
    unsafe { engine().count }
}
#[no_mangle]
pub extern "C" fn allocated_tiles() -> usize {
    unsafe { engine().tiles.iter().flatten().count() }
}
#[no_mangle]
pub extern "C" fn wet_total() -> f64 {
    unsafe {
        engine()
            .tiles
            .iter()
            .flatten()
            .flat_map(|t| t.iter())
            .map(|p| p.wet_height)
            .fold(0.0, |sum, v| sum + v as f64 / HEIGHT_SCALE as f64)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn total(e: &Engine) -> f32 {
        e.tiles
            .iter()
            .flatten()
            .flat_map(|t| t.iter())
            .flat_map(|p| p.wet)
            .map(|v| v as f32 / OD_SCALE)
            .sum()
    }
    #[test]
    fn roller_is_finite_conservative_and_stationary_does_not_spray() {
        let mut e = Engine::new(256);
        e.source.fill(0);
        e.binary = true;
        e.refresh_surface();
        e.roller_load(64., 0.8, false, 0xbc3d32, 1.);
        let before = e.roller_film.iter().sum::<f32>() * 64.;
        e.roller_move(80., 80., 80., 80.);
        assert_eq!(e.coat.iter().sum::<f32>(), 0.);
        e.roller_move(80., 80., 380., 80.);
        let on_plate = e.coat.iter().sum::<f32>();
        let remaining = e.roller_film.iter().sum::<f32>() * 64.;
        assert!(on_plate > 0. && remaining < before);
        assert!((on_plate + remaining - before).abs() < 0.02);
        e.roller_load(64., 0.8, true, 0xbc3d32, 1.);
        e.roller_move(80., 80., 380., 80.);
        assert!(e.coat.iter().sum::<f32>() < on_plate);
        e.source.fill(255);
        e.refresh_surface();
        e.clear_ink();
        e.roller_load(64., 0.8, false, 0xbc3d32, 1.);
        e.roller_move(80., 80., 380., 80.);
        assert_eq!(e.coat.iter().sum::<f32>(), 0.);
    }
    #[test]
    fn contact_changes_with_pressure_and_uninked_plate_embosses() {
        let make = || {
            let mut e = Engine::new(256);
            e.source.fill(0);
            e.binary = true;
            e
        };
        let mut low = make();
        low.begin(Params {
            pressure: 0.1,
            rough: 0.95,
            amount: 0.02,
            rgb: 0x222222,
            ..Params::default()
        });
        low.rows(0, low.m);
        low.finish();
        let mut high = make();
        high.begin(Params {
            pressure: 0.9,
            rough: 0.95,
            amount: 0.02,
            rgb: 0x222222,
            ..Params::default()
        });
        high.rows(0, high.m);
        high.finish();
        assert!(total(&high) > total(&low));
        let mut blind = make();
        blind.begin(Params {
            pressure: 0.7,
            rough: 0.5,
            ..Params::default()
        });
        blind.rows(0, blind.m);
        blind.finish();
        assert_eq!(total(&blind), 0.);
        assert!(blind
            .tiles
            .iter()
            .flatten()
            .any(|t| t.iter().any(|p| p.relief > 0)));
    }
    #[test]
    fn peeling_elasticity_leaves_directional_filaments() {
        let make = |elasticity| {
            let mut e = Engine::new(256);
            e.binary = true;
            e.elasticity = elasticity;
            for y in 60..140 {
                for x in 40..80 {
                    e.source[y * e.m + x] = 0;
                }
            }
            e.begin(Params {
                pressure: 0.9,
                rough: 0.,
                speed: 1.,
                visc: 0.65,
                amount: 0.6,
                rgb: 0x222222,
                ..Params::default()
            });
            e.rows(0, e.m);
            e.finish();
            e
        };
        let smooth = make(0.);
        let elastic = make(1.);
        let outside = |e: &Engine| {
            let mut sum = 0.;
            for y in 60..140 {
                for x in 80..90 {
                    sum += e.pixel(x + e.border, y + e.border).wet[0] as f32;
                }
            }
            sum
        };
        assert!(outside(&elastic) > outside(&smooth));
    }
    #[test]
    fn transfer_is_bounded_and_has_finite_acceptance() {
        for film in [0., 0.001, 0.05, 0.2, 1., 4.] {
            for coverage in [0., 0.2, 1.] {
                for split in [0., 0.5, 1.] {
                    let mass = transferred_film(film, coverage, 0.2, split);
                    assert!(mass >= 0. && mass <= film + 1e-6);
                }
            }
        }
        assert_eq!(transferred_film(1., 0., 0.2, 0.5), 0.);
        assert!(transferred_film(4., 1., 0.2, 0.) <= 0.2);
        assert!(transferred_film(1., 1., 0.4, 0.5) > transferred_film(1., 1., 0.1, 0.5));
    }
    #[test]
    fn thick_ink_keeps_the_original_edge_and_spreads_to_both_sides_of_a_line() {
        let mut e = Engine::new(4096);
        e.binary = true;
        let center = e.m / 2;
        for y in center - 32..center + 32 {
            e.source[y * e.m + center] = 0;
        }
        e.begin(Params {
            pressure: 0.85,
            visc: 0.15,
            amount: 0.9,
            rgb: 0xbc3d32,
            ..Params::default()
        });
        e.rows(center - 32, 64);
        e.finish();
        let center = center + e.border;
        for dx in 1..=5 {
            let left = e.pixel(center - dx, center).wet_height;
            assert!(left > 0);
            assert_eq!(left, e.pixel(center + dx, center).wet_height);
        }
        assert!(e.pixel(center, center).wet_height > e.pixel(center + 1, center).wet_height);
    }

    #[test]
    fn quantized_transfer_depletes_only_film_accepted_by_paper() {
        let mut e = Engine::new(4096);
        e.binary = true;
        let center = e.m / 2;
        for y in center - 8..center + 8 {
            let start = y * e.m + center - 8;
            e.source[start..start + 16].fill(0);
        }
        let params = Params {
            pressure: 1.,
            visc: 0.6,
            mode: 2,
            ..Params::default()
        };
        let total_coat = |e: &Engine| e.coat.iter().map(|q| *q as f64).sum::<f64>();
        let area = ((e.m - 1) as f64 / (COAT - 1) as f64).powi(2);
        for load in [0.005, 0.75] {
            e.new_paper();
            e.coat.fill(load);
            e.pigment.fill(absorption(0xbc3d32));
            let before = total_coat(&e);
            e.begin(params);
            e.rows(center - 8, 16);
            e.finish();
            let deposited = e
                .tiles
                .iter()
                .flatten()
                .flat_map(|tile| tile.iter())
                .map(|p| p.wet_height as f64 / HEIGHT_SCALE as f64)
                .sum::<f64>();
            let depleted = (before - total_coat(&e)) * 1.35 * area;
            assert_eq!(deposited > 0., load > 0.01);
            assert!((deposited - depleted).abs() < 0.001);
        }
    }

    #[test]
    fn trapping_distinguishes_wet_and_dry_underprints_and_freezes_the_substrate() {
        let mut e = Engine::new(256);
        let pigment = absorption(0xbc3d32);
        e.deposit(10, 10, 0.6, pigment);
        e.begin(Params {
            pressure: 1.,
            ..Params::default()
        });
        let before = e.substrate_pixel(10, 10);
        e.deposit(10, 10, 0.3, pigment);
        e.deposit(11, 10, 0.6, pigment);
        assert_eq!(e.substrate_pixel(10, 10).wet_height, before.wet_height);
        assert_eq!(e.substrate_pixel(11, 10).wet_height, 0);
        e.finish();
        e.dry();
        let dry = e.pixel(11, 10);
        assert_eq!(dry.dry_height, before.wet_height);
        assert!(e.physics.trapping(before) < e.physics.trapping(dry));
        assert!(e.physics.trapping(dry) < e.physics.trapping(Pixel::default()));
    }

    #[test]
    fn scattering_survives_drying_even_when_surface_film_shrinks() {
        let mut e = Engine::new(256);
        e.physics.dry_retention = 0.5;
        for x in [0, 1] {
            e.deposit(x, 0, 1., absorption(0));
        }
        e.dry();
        e.deposit(0, 0, 0.5, ink_pigment(0xffffff, 0.2));
        e.deposit(1, 0, 0.5, ink_pigment(0xffffff, 2.));
        let translucent = e.pixel(0, 0).reflectance()[0];
        let opaque = e.pixel(1, 0).reflectance()[0];
        let alpha = e.ink_rgba(1, 0)[3];
        assert!(opaque > translucent + 0.3);
        assert_eq!(e.pixel(1, 0).height(), 1.);
        e.dry();
        assert_eq!(e.pixel(1, 0).height(), 0.75);
        assert!((e.pixel(1, 0).reflectance()[0] - opaque).abs() < 0.00002);
        assert!((e.ink_rgba(1, 0)[3] - alpha).abs() < 0.00002);
    }

    #[test]
    fn export_at_same_resolution_samples_the_original_cell() {
        let mut e = Engine::new(256);
        e.deposit(70, 80, 1., [1., 1., 1., SCATTER]);
        let rgb = e.shade(70, 80);
        e.render(256, true);
        let k = (80 * 256 + 70) * 4;
        for c in 0..3 {
            assert!((e.export[k + c] as f32 - rgb[c]).abs() < 1.);
        }
    }
    #[test]
    fn no_contact_no_transfer() {
        let mut e = Engine::new(256);
        e.source.fill(0);
        e.begin(Params {
            pressure: 0.,
            amount: 1.,
            ..Params::default()
        });
        e.rows(0, e.m);
        e.finish();
        assert_eq!(total(&e), 0.);
        assert!(e.tiles.iter().all(Option::is_none));
    }
    #[test]
    fn hand_coating_depletes() {
        let mut e = Engine::new(256);
        e.source.fill(0);
        e.coat.fill(0.55);
        e.pigment.fill([1., 1., 1., SCATTER]);
        let before: f32 = e.coat.iter().sum();
        e.begin(Params {
            pressure: 1.,
            mode: 2,
            ..Params::default()
        });
        e.rows(0, e.m);
        e.finish();
        assert!(e.coat.iter().sum::<f32>() < before);
        assert!(total(&e) > 0.);
    }
    #[test]
    fn deposition_preserves_mass() {
        let mut e = Engine::new(256);
        e.deposit(0, 0, 2., [1., 2., 3., SCATTER]);
        assert!((total(&e) - 12.).abs() < 0.001);
    }
    #[test]
    fn export_averages_four_simulated_cells() {
        let mut e = Engine::new(256);
        e.deposit(0, 0, 1., [1., 1., 1., SCATTER]);
        e.deposit(1, 0, 2., [1., 1., 1., SCATTER]);
        e.deposit(0, 1, 3., [1., 1., 1., SCATTER]);
        e.deposit(1, 1, 4., [1., 1., 1., SCATTER]);
        let mean =
            (e.shade(0, 0)[0] + e.shade(1, 0)[0] + e.shade(0, 1)[0] + e.shade(1, 1)[0]) * 0.25;
        e.render(128, true);
        assert!((e.export[0] as f32 - mean).abs() < 1.);
        assert_eq!(e.export.len(), 128 * 128 * 4);
    }
    #[test]
    fn transparent_export_removes_only_paper_and_averages_premultiplied_color() {
        let mut e = Engine::new(256);
        e.deposit(0, 0, 0.1, [0.2, 1., 2., SCATTER]);
        let ink = e.ink_rgba(0, 0);
        assert!(ink[3] > 0. && ink[3] < 1.);
        for c in 0..3 {
            let transmission = e.pixel(0, 0).reflectance()[c];
            assert!((ink[c] + 1. - ink[3] - transmission).abs() < 1e-6);
        }
        e.render_transparent(128);
        assert_eq!(e.export[3], (ink[3] * 0.25 * 255.).round() as u8);
        assert_eq!(&e.export[4..8], &[0, 0, 0, 0]);
        let before = e.export.clone();
        e.dry();
        e.render_transparent(128);
        assert!(e
            .export
            .iter()
            .zip(before)
            .all(|(a, b)| (*a as i16 - b as i16).abs() <= 1));
        e.new_paper();
        e.render_transparent(128);
        assert!(e.export.iter().all(|&v| v == 0));
    }
    #[test]
    fn wet_mix_is_order_independent_but_dry_layers_are_ordered() {
        let paint = |first, second, dry| {
            let mut e = Engine::new(256);
            e.deposit(20, 20, 0.8, absorption(first));
            if dry {
                e.dry();
            }
            e.deposit(20, 20, 0.8, absorption(second));
            e.pixel(20, 20).reflectance()
        };
        let wet = paint(0xe83020, 0x2040df, false);
        assert_eq!(wet, paint(0x2040df, 0xe83020, false));
        let layered = paint(0xe83020, 0x2040df, true);
        let reversed = paint(0x2040df, 0xe83020, true);
        assert!(wet.iter().zip(layered).any(|(a, b)| (a - b).abs() > 0.02));
        assert!(layered
            .iter()
            .zip(reversed)
            .any(|(a, b)| (a - b).abs() > 0.02));
    }
    #[test]
    fn thickness_persists_and_wet_flow_cannot_move_dry_pigment() {
        let mut e = Engine::new(256);
        e.deposit(20, 20, 0.4, absorption(0xbc3d32));
        let height = e.pixel(20, 20).height();
        e.dry();
        assert_eq!(e.pixel(20, 20).height(), height);
        let dry = e.pixel(20, 20).dry;
        let dry_height = e.pixel(20, 20).dry_height;
        e.deposit(20, 20, 0.6, absorption(0x2040df));
        let before = e.pixel(20, 20);
        e.flow_wet(20, 20, 21, 20, 0.5);
        let a = e.pixel(20, 20);
        let b = e.pixel(21, 20);
        assert_eq!(a.dry, dry);
        assert_eq!(a.dry_height, dry_height);
        assert_eq!(b.dry_height, 0);
        assert_eq!(
            a.wet_height as u32 + b.wet_height as u32,
            before.wet_height as u32
        );
        for c in 0..3 {
            assert_eq!(a.wet[c] as u32 + b.wet[c] as u32, before.wet[c] as u32);
        }
        assert!(b.wet_height > 0);
    }
    #[test]
    fn white_ink_exports_and_optical_layers_are_bounded() {
        let mut e = Engine::new(256);
        e.deposit(0, 0, 0.5, absorption(0xffffff));
        let ink = e.ink_rgba(0, 0);
        assert!(ink[3] > 0.);
        assert!((ink[0] / ink[3] - 1.).abs() < 1e-5);
        for k in [0., 0.001, 1., 60.] {
            for s in [0., 0.001, 1., 60.] {
                for b in [0., 0.5, 1.] {
                    let r = layer_over(k, s, b);
                    assert!(r.is_finite() && (0. ..=1.).contains(&r));
                }
            }
        }
        assert_eq!(std::mem::size_of::<Pixel>(), 22);
    }
    #[test]
    fn saturated_films_keep_absorption_and_height_consistent() {
        let mut e = Engine::new(256);
        let pigment = absorption(0x000000);
        e.deposit(0, 0, 100., pigment);
        let p = e.pixel(0, 0);
        assert!(p.height() <= 16.);
        for c in 0..3 {
            assert!((p.wet[c] as f32 / OD_SCALE - p.height() * pigment[c]).abs() < 0.001);
        }
        e.dry();
        e.deposit(0, 0, 100., absorption(0xffffff));
        e.dry();
        assert!(e.pixel(0, 0).height() <= 16.);
        assert_eq!(e.pixel(0, 0).wet_height, 0);
    }
    #[test]
    fn drying_and_new_paper() {
        let mut e = Engine::new(256);
        e.deposit(20, 20, 1., [1., 2., 3., SCATTER]);
        let before = e.shade(20, 20);
        e.dry();
        assert_eq!(total(&e), 0.);
        for c in 0..3 {
            assert!((e.shade(20, 20)[c] - before[c]).abs() < 0.01);
        }
        e.new_paper();
        assert!(e.tiles.iter().all(Option::is_none));
    }
}
