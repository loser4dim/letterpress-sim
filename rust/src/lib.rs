//! Selectable 4096²/8192² sparse paper grid; output is always 4096².
//! Plate coating uses a bilinear 512² field. Paper stores quantized optical density.
use std::ptr;
const SIM: usize = 8192;
const OUTPUT: usize = 4096;
const PREVIEW: usize = 640;
const COAT: usize = 512;
const TILE: usize = 64;
const OD_SCALE: f32 = 4096.;
#[derive(Clone, Copy, Default)]
struct Pixel {
    wet: [u16; 3],
    dry: [u16; 3],
    relief: u8,
}
struct Engine {
    n: usize,
    m: usize,
    border: usize,
    tiles: Vec<Option<Box<[Pixel]>>>,
    source: Vec<u8>,
    coat: Vec<f32>,
    pigment: Vec<[f32; 3]>,
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
            pigment: vec![[0.; 3]; COAT * COAT],
            image: vec![0; PREVIEW * PREVIEW * 4],
            plate: vec![0; COAT * COAT * 4],
            export: Vec::new(),
            count: 0,
            seed: 41,
            binary: false,
            threshold: 150.,
            invert: false,
            depletion: vec![0.; COAT * COAT],
            paint_snapshot: vec![0.; COAT * COAT],
            params: Params::default(),
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
        self.count = 0;
        self.seed = self.seed.wrapping_add(7);
    }
    fn dry(&mut self) {
        for tile in self.tiles.iter_mut().flatten() {
            for pixel in tile.iter_mut() {
                for c in 0..3 {
                    pixel.dry[c] = pixel.dry[c].saturating_add(pixel.wet[c]);
                    pixel.wet[c] = 0;
                }
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
    fn coating(&self, x: i32, y: i32, params: Params) -> (f32, [f32; 3], usize) {
        let cx = (x as f32 / (self.m - 1) as f32 * (COAT - 1) as f32).clamp(0., (COAT - 1) as f32);
        let cy = (y as f32 / (self.m - 1) as f32 * (COAT - 1) as f32).clamp(0., (COAT - 1) as f32);
        let k = cy.round() as usize * COAT + cx.round() as usize;
        if params.mode != 2 {
            let a = params.gradient.to_radians();
            let t = ((x as f32 * a.cos() + y as f32 * a.sin())
                / ((self.m - 1) as f32 * (a.cos() + a.sin()).max(0.001)))
            .clamp(0., 1.);
            return (
                if params.mode == 1 {
                    params.amount * (1. - t) + params.end * t
                } else {
                    params.amount
                },
                absorption(params.rgb),
                k,
            );
        }
        let x0 = cx.floor() as usize;
        let y0 = cy.floor() as usize;
        let x1 = (x0 + 1).min(COAT - 1);
        let y1 = (y0 + 1).min(COAT - 1);
        let fx = cx - x0 as f32;
        let fy = cy - y0 as f32;
        let mut load = 0.;
        let mut color = [0.; 3];
        for (i, w) in [
            (y0 * COAT + x0, (1. - fx) * (1. - fy)),
            (y0 * COAT + x1, fx * (1. - fy)),
            (y1 * COAT + x0, (1. - fx) * fy),
            (y1 * COAT + x1, fx * fy),
        ] {
            let q = if self.paint_snapshot.is_empty() {
                self.coat[i]
            } else {
                self.paint_snapshot[i]
            };
            load += q * w;
            for c in 0..3 {
                color[c] += self.pigment[i][c] * q * w;
            }
        }
        if load > 0. {
            for c in &mut color {
                *c /= load;
            }
        }
        (load, color, k)
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
                    for c in 0..3 {
                        self.pigment[k][c] =
                            (self.pigment[k][c] * old + pigment[c] * (next - old)) / next;
                    }
                }
                self.coat[k] = next;
                if next == 0. {
                    self.pigment[k] = [0.; 3];
                }
            }
        }
        self.paint_snapshot.clear();
    }
    fn clear_ink(&mut self) {
        self.coat.fill(0.);
        self.pigment.fill([0.; 3]);
        self.paint_snapshot.clear();
    }
    fn deposit(&mut self, x: i32, y: i32, mass: f32, pigment: [f32; 3]) {
        if mass <= 0. {
            return;
        }
        let n = self.n as i32;
        let p = self.pixel_mut(x.clamp(0, n - 1) as usize, y.clamp(0, n - 1) as usize);
        for c in 0..3 {
            p.wet[c] = p.wet[c]
                .saturating_add((mass * pigment[c] * OD_SCALE).round().clamp(0., 65535.) as u16);
        }
    }
    fn begin(&mut self, p: Params) {
        self.params = p;
        self.depletion.fill(0.);
        self.paint_snapshot.clone_from(&self.coat);
    }
    fn rows(&mut self, start: usize, rows: usize) {
        let p = self.params;
        if p.pressure == 0. {
            return;
        }
        let scale = self.n as f32 / 640.;
        let a = p.peel.to_radians();
        let max_y = (start + rows).min(self.m);
        for py in start..max_y {
            for px in 0..self.m {
                if self.mask(px as i32, py as i32) == 0. {
                    continue;
                }
                let (local, pigment, k) = self.coating(px as i32, py as i32, p);
                if local == 0. {
                    continue;
                }
                let x = px as i32 + self.border as i32 + (p.ox as f32 * scale).round() as i32;
                let y = py as i32 + self.border as i32 + (p.oy as f32 * scale).round() as i32;
                if x < 0 || y < 0 || x >= self.n as i32 || y >= self.n as i32 {
                    continue;
                }
                let grain = hash(x / 4, y / 4, self.seed) * 0.65 + hash(x, y, self.seed) * 0.35;
                let lx = x as f32 / scale;
                let ly = y as f32 / scale;
                let fiber = (0.5
                    + 0.22 * (lx * 0.75 + (ly * 0.045).sin() * 3.).sin()
                    + 0.16 * (ly * 0.35 + lx * 0.1).sin())
                .clamp(0., 1.);
                let damage = if hash(px as i32 / 4, py as i32 / 4, 919) > 0.996 {
                    0.75
                } else {
                    0.
                };
                let contact = ((p.pressure * (0.9 + 0.1 * (lx * 0.008 + ly * 0.005).sin()) * 1.1
                    + local * 1.35 * 0.20
                    - p.rough * (0.62 * grain + 0.38 * fiber)
                    - damage)
                    * 4.)
                    .clamp(0., 1.);
                let roller = 0.84
                    + 0.12 * (px as f32 / scale * 0.025 + py as f32 / scale * 0.006).sin()
                    + 0.06 * hash(px as i32 / 4, py as i32 / 4, self.count + 79);
                let film = local * 1.35;
                let split = (0.5 / (1. + 0.6 * p.speed + 0.15 * film)).clamp(0.15, 0.5);
                let capacity = 0.16 * (0.4 + 0.6 * p.rough) / (0.4 + p.visc);
                // 0.125 is the illustrative film scale for reaching broad coverage;
                // it is not a measured micrometre thickness.
                let coverage =
                    contact * (1. - (-(film / 0.125 * (1. + p.pressure * 3.)).powi(2)).exp());
                let mass = transferred_film(film, coverage, capacity, split) * roller.min(1.);
                if mass <= 0. {
                    continue;
                }
                if p.mode == 2 {
                    self.depletion[k] += mass / 1.35 / (self.m as f32 / COAT as f32).powi(2);
                }
                let previous = self.pixel(x as usize, y as usize);
                self.pixel_mut(x as usize, y as usize).relief = previous
                    .relief
                    .saturating_add((p.pressure * 89.).round() as u8);
                let excess = (local - 0.65).max(0.);
                let spread = (excess * p.pressure * (1. - p.visc) * 5.).min(7.) * scale;
                // Deterministic stochastic transport: each 8K cell sends its pigment to a
                // sampled destination. No convolution buffers or fictitious extra ink.
                let angle = hash(px as i32, py as i32, 173) * std::f32::consts::TAU;
                let radius = hash(px as i32, py as i32, 174).sqrt() * spread;
                let dx = (angle.cos() * radius).round() as i32;
                let dy = (angle.sin() * radius).round() as i32;
                let bleed = (mass * (1. - p.visc) * p.rough * 0.12).clamp(0., 0.12);
                let edge = self.mask(px as i32 - 1, py as i32) == 0.
                    || self.mask(px as i32 + 1, py as i32) == 0.
                    || self.mask(px as i32, py as i32 - 1) == 0.
                    || self.mask(px as i32, py as i32 + 1) == 0.;
                let flick = if edge
                    && excess > 0.
                    && hash(px as i32, py as i32, self.count + 213)
                        < excess.min(1.) * p.speed * 0.035
                {
                    0.10 * p.speed
                } else {
                    0.
                };
                self.deposit(x + dx, y + dy, mass * (1. - bleed - flick), pigment);
                if bleed > 0. {
                    let distance = radius + 2. * scale;
                    self.deposit(
                        x + (angle.cos() * distance).round() as i32,
                        y + (angle.sin() * distance).round() as i32,
                        mass * bleed,
                        pigment,
                    );
                }
                if flick > 0. {
                    let distance =
                        (5. + hash(px as i32, py as i32, self.count + 313) * excess * 22.) * scale;
                    let side = (hash(px as i32, py as i32, 414) - 0.5) * distance;
                    self.deposit(
                        x + (a.cos() * distance - a.sin() * side).round() as i32,
                        y + (a.sin() * distance + a.cos() * side).round() as i32,
                        mass * flick,
                        pigment,
                    );
                }
                let smear = p.speed * p.visc * 2. * scale;
                let nx =
                    (x + (a.cos() * smear).round() as i32).clamp(0, self.n as i32 - 1) as usize;
                let ny =
                    (y + (a.sin() * smear).round() as i32).clamp(0, self.n as i32 - 1) as usize;
                if nx != x as usize || ny != y as usize {
                    let q = self.pixel(nx, ny);
                    let mobility = (mass * 0.12 * (1. - p.visc)).clamp(0., 0.1);
                    for c in 0..3 {
                        let exchange =
                            ((q.wet[c] as f32 - previous.wet[c] as f32) * mobility).round() as i32;
                        if exchange != 0 {
                            let here = self.pixel(x as usize, y as usize).wet[c] as i32;
                            let there = q.wet[c] as i32;
                            let delta = exchange
                                .clamp(-here, there)
                                .clamp(-(65535 - there), 65535 - here);
                            self.pixel_mut(x as usize, y as usize).wet[c] = (here + delta) as u16;
                            self.pixel_mut(nx, ny).wet[c] = (there - delta) as u16;
                        }
                    }
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
        self.count += 1;
    }
    fn shade(&self, x: usize, y: usize) -> [f32; 3] {
        let p = self.pixel(x, y);
        let left = self.pixel(x.saturating_sub(1), y).relief as f32;
        let above = self.pixel(x, y.saturating_sub(1)).relief as f32;
        let shade = (1. - 0.026 * hash(x as i32 / 4, y as i32 / 4, self.seed)
            + 0.12 * (left + above - 2. * p.relief as f32) / 255.)
            .clamp(0.85, 1.08);
        let mut rgb = [0.; 3];
        for c in 0..3 {
            rgb[c] = [249., 245., 232.][c]
                * shade
                * (-(p.dry[c] as f32 + p.wet[c] as f32) / OD_SCALE).exp();
        }
        rgb
    }
    fn render(&mut self, size: usize, export: bool) {
        let mut bytes = if export {
            std::mem::take(&mut self.export)
        } else {
            std::mem::take(&mut self.image)
        };
        bytes.resize(size * size * 4, 0);
        let factor = self.n as f32 / size as f32;
        for y in 0..size {
            for x in 0..size {
                let mut sum = [0.; 3];
                for (fx, fy) in [(0.25, 0.25), (0.75, 0.25), (0.25, 0.75), (0.75, 0.75)] {
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
                    bytes[k + c] = (sum[c] * 0.25).clamp(0., 255.) as u8;
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
        let density = [0, 1, 2].map(|c| (p.wet[c] as f32 + p.dry[c] as f32) / OD_SCALE);
        let maximum = density.iter().copied().fold(0., f32::max);
        if maximum == 0. {
            return [0.; 4];
        }
        // Optical-density filter represented as RGBA over white. Premultiplied RGB
        // allows averaging without beige paper fringes at thin/antialiased edges.
        let transmission_min = (-maximum).exp();
        [
            (-density[0]).exp() - transmission_min,
            (-density[1]).exp() - transmission_min,
            (-density[2]).exp() - transmission_min,
            1. - transmission_min,
        ]
    }
    fn render_transparent(&mut self, size: usize) {
        let mut bytes = std::mem::take(&mut self.export);
        bytes.resize(size * size * 4, 0);
        let factor = self.n as f32 / size as f32;
        for y in 0..size {
            for x in 0..size {
                let mut sum = [0.; 4];
                for (fx, fy) in [(0.25, 0.25), (0.75, 0.25), (0.25, 0.75), (0.75, 0.75)] {
                    let rgba = self.ink_rgba(
                        ((x as f32 + fx) * factor).floor().min((self.n - 1) as f32) as usize,
                        ((y as f32 + fy) * factor).floor().min((self.n - 1) as f32) as usize,
                    );
                    for c in 0..4 {
                        sum[c] += rgba[c] * 0.25;
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
                let (load, pigment, _) = self.coating(px, py, p);
                let bare = if self.mask(px, py) > 0. { 98. } else { 188. };
                let opacity = 1. - (-load * 1.5).exp();
                let k = (y * COAT + COAT - 1 - x) * 4;
                for c in 0..3 {
                    self.plate[k + c] = ((bare + hash(x as i32, y as i32, 919) * 9.)
                        * (1. - opacity)
                        + 255. * (-pigment[c] * 0.9).exp() * opacity)
                        as u8;
                }
                self.plate[k + 3] = 255;
            }
        }
    }
}
fn absorption(rgb: u32) -> [f32; 3] {
    [rgb >> 16 & 255, rgb >> 8 & 255, rgb & 255].map(|c| -(c as f32 / 255.).max(0.04).ln())
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
            .flat_map(|p| p.wet)
            .fold(0.0, |sum, v| sum + v as f64 / OD_SCALE as f64)
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
    fn export_at_same_resolution_samples_the_original_cell() {
        let mut e = Engine::new(256);
        e.deposit(70, 80, 1., [1.; 3]);
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
        e.pigment.fill([1.; 3]);
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
        e.deposit(0, 0, 2., [1., 2., 3.]);
        assert!((total(&e) - 12.).abs() < 0.001);
    }
    #[test]
    fn export_averages_four_simulated_cells() {
        let mut e = Engine::new(256);
        e.deposit(0, 0, 1., [1.; 3]);
        e.deposit(1, 0, 2., [1.; 3]);
        e.deposit(0, 1, 3., [1.; 3]);
        e.deposit(1, 1, 4., [1.; 3]);
        let mean =
            (e.shade(0, 0)[0] + e.shade(1, 0)[0] + e.shade(0, 1)[0] + e.shade(1, 1)[0]) * 0.25;
        e.render(128, true);
        assert!((e.export[0] as f32 - mean).abs() < 1.);
        assert_eq!(e.export.len(), 128 * 128 * 4);
    }
    #[test]
    fn transparent_export_removes_only_paper_and_averages_premultiplied_color() {
        let mut e = Engine::new(256);
        e.deposit(0, 0, 0.1, [0.2, 1., 2.]);
        let ink = e.ink_rgba(0, 0);
        assert!(ink[3] > 0. && ink[3] < 1.);
        for c in 0..3 {
            let transmission = (-(e.pixel(0, 0).wet[c] as f32) / OD_SCALE).exp();
            assert!((ink[c] + 1. - ink[3] - transmission).abs() < 1e-6);
        }
        e.render_transparent(128);
        assert_eq!(e.export[3], (ink[3] * 0.25 * 255.).round() as u8);
        assert_eq!(&e.export[4..8], &[0, 0, 0, 0]);
        let before = e.export.clone();
        e.dry();
        e.render_transparent(128);
        assert_eq!(e.export, before);
        e.new_paper();
        e.render_transparent(128);
        assert!(e.export.iter().all(|&v| v == 0));
    }
    #[test]
    fn drying_and_new_paper() {
        let mut e = Engine::new(256);
        e.deposit(20, 20, 1., [1., 2., 3.]);
        let before = e.shade(20, 20);
        e.dry();
        assert_eq!(total(&e), 0.);
        assert_eq!(e.shade(20, 20), before);
        e.new_paper();
        assert!(e.tiles.iter().all(Option::is_none));
    }
}
