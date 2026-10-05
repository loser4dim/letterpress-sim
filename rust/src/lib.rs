//! Single-threaded browser engine. Exported pointers remain valid until engine_init.
//! Color uses optical-density approximations, not calibrated pigment spectra.
const N: usize = 640;
const M: usize = 512;
const SIZE: usize = N * N;
struct Engine {
    mask: Vec<f32>, coat: Vec<f32>, dry: Vec<f32>, wet: Vec<f32>,
    grain: Vec<f32>, fiber: Vec<f32>, image: Vec<u8>, plate: Vec<u8>, count: u32, seed: u32,
}
impl Engine {
    fn new() -> Self {
        let mut e = Self { mask: vec![0.; M*M], coat: vec![0.55; M*M], dry: vec![0.; SIZE*3], wet: vec![0.; SIZE*3], grain: vec![0.; SIZE], fiber: vec![0.; SIZE], image: vec![0; SIZE*4], plate: vec![0; M*M*4], count: 0, seed: 41 };
        e.new_paper(); e
    }
    fn new_paper(&mut self) {
        self.dry.fill(0.); self.wet.fill(0.); self.count = 0; self.seed = self.seed.wrapping_add(7);
        for y in 0..N { for x in 0..N {
            let i=y*N+x; self.grain[i]=hash(x as i32,y as i32,self.seed);
            self.fiber[i]=(0.5+0.22*(x as f32*0.75+(y as f32*0.045).sin()*3.).sin()+0.16*(y as f32*0.35+x as f32*0.1).sin()).clamp(0.,1.);
        }}
        self.render();
    }
    fn render(&mut self) {
        for i in 0..SIZE {
            let shade=1.-0.026*self.grain[i]-0.01*self.fiber[i];
            for c in 0..3 { self.image[i*4+c]=([249.,245.,232.][c]*shade*(-self.dry[i*3+c]-self.wet[i*3+c]).exp()).clamp(0.,255.) as u8; }
            self.image[i*4+3]=255;
        }
    }
    fn mask_at(&self,x:i32,y:i32)->f32 { if x<0||y<0||x>=M as i32||y>=M as i32 {0.} else {self.mask[y as usize*M+x as usize]} }
    fn ink_at(&self,x:i32,y:i32,mode:u32,amount:f32,end:f32,angle:f32)->f32 {
        if x<0||y<0||x>=M as i32||y>=M as i32 {return 0.;}
        if mode==2 {return self.coat[y as usize*M+x as usize];}
        if mode==1 {
            let a=angle.to_radians(); let t=((x as f32*a.cos()+y as f32*a.sin())/((M-1) as f32*(a.cos()+a.sin()).max(0.001))).clamp(0.,1.);
            return amount*(1.-t)+end*t;
        }
        amount
    }
    fn update_plate(&mut self,mode:u32,amount:f32,end:f32,angle:f32,rgb:u32) {
        let colors=color(rgb);
        for y in 0..M {for x in 0..M {
            let i=y*M+x;let q=(y*M+M-1-x)*4;let load=self.ink_at(x as i32,y as i32,mode,amount,end,angle);
            for c in 0..3 {self.plate[q+c]=if self.mask[i]>0. {45.*(1.-load)+colors[c]*255.*load} else {221.} as u8;}
            self.plate[q+3]=255;
        }}
    }
    fn paint(&mut self,x:f32,y:f32,r:f32,strength:f32,erase:bool) {
        let r=r.clamp(1.,128.); let strength=strength.clamp(0.,1.)*0.28;
        for py in ((y-r).floor() as i32).max(0)..((y+r).ceil() as i32).min(M as i32) {
            for px in ((x-r).floor() as i32).max(0)..((x+r).ceil() as i32).min(M as i32) {
                let d=((px as f32-x).powi(2)+(py as f32-y).powi(2)).sqrt()/r;
                if d>1. {continue;}
                let i=py as usize*M+px as usize;let w=(1.-d*d)*strength;
                self.coat[i]=(self.coat[i]+if erase {-w} else {w}).clamp(0.,1.);
            }
        }
    }
    #[allow(clippy::too_many_arguments)]
    fn imprint(&mut self,pressure:f32,rough:f32,speed:f32,visc:f32,amount:f32,mode:u32,end:f32,gradient_angle:f32,peel_angle:f32,ox:i32,oy:i32,rgb:u32) {
        let rgb=color(rgb);let absorption=rgb.map(|v|-v.max(0.04).ln());
        let lateral=(pressure*amount*(1.-visc)*3.).floor() as i32;
        let a=peel_angle.to_radians(); let previous=self.wet.clone();
        // Flux exchanges each pair conservatively: no pigment is created by wet smearing.
        let mut flux=vec![0.;SIZE*3];
        for y in 50..N-50 {for x in 50..N-50 {
            let px=x as i32-64-ox; let py=y as i32-64-oy;
            let mut coverage=self.mask_at(px,py);
            if coverage==0. && lateral>0 {coverage=0.35*self.mask_at(px-lateral,py).max(self.mask_at(px+lateral,py)).max(self.mask_at(px,py-lateral)).max(self.mask_at(px,py+lateral));}
            let local=self.ink_at(px,py,mode,amount,end,gradient_angle);
            if coverage==0.||local==0.||pressure==0. {continue;}
            let load=local*1.35;let i=y*N+x;
            let surface=rough*(0.62*self.grain[i]+0.38*self.fiber[i]);
            let damage=if hash(px,py,919)>0.996 {0.75}else{0.};
            let p=pressure*(0.9+0.1*(x as f32*0.008+y as f32*0.005).sin());
            let contact=((p*1.1+load*0.20-surface-damage)*4.).clamp(0.,1.);
            let roller=0.84+0.12*(px as f32*0.025+py as f32*0.006).sin()+0.06*hash(px,py,self.count+79);
            let along=x as f32*a.cos()+y as f32*a.sin();
            let split=(0.85-0.28*speed*visc+0.10*speed*(along*0.17+self.grain[i]*4.).sin()).clamp(0.15,0.95);
            let deposit=coverage*load*contact*split*roller;
            if deposit==0. {continue;}
            if mode==2 && px>=0&&py>=0&&px<M as i32&&py<M as i32 {
                let k=py as usize*M+px as usize;self.coat[k]=(self.coat[k]-deposit/1.35).max(0.);
            }
            let smear=(speed*visc*2.).round();
            let nx=(x as i32+(a.cos()*smear).round() as i32).clamp(0,N as i32-1) as usize;
            let ny=(y as i32+(a.sin()*smear).round() as i32).clamp(0,N as i32-1) as usize;
            let j=(ny*N+nx)*3;let mobility=(deposit*0.12*(1.-visc)).clamp(0.,0.1);
            for c in 0..3 {
                let k=i*3+c;let exchange=(previous[j+c]-previous[k])*mobility;
                flux[k]+=exchange;flux[j+c]-=exchange;
                self.wet[k]+=absorption[c]*deposit;
            }
        }}
        for (v,f) in self.wet.iter_mut().zip(flux) {*v=(*v+f).max(0.);}
        self.count+=1;self.render();
    }
}
fn color(rgb:u32)->[f32;3] {[(rgb>>16&255) as f32/255.,(rgb>>8&255) as f32/255.,(rgb&255) as f32/255.]}
fn hash(x:i32,y:i32,s:u32)->f32 {
    let mut a=(x as u32).wrapping_add(17).wrapping_mul(374761393)^(y as u32).wrapping_add(31).wrapping_mul(668265263)^s.wrapping_mul(1274126177);
    a=(a^(a>>13)).wrapping_mul(1274126177);((a^(a>>16)) as f64/u32::MAX as f64) as f32
}
// No Rust references cross the ABI; JS calls are synchronous and engine memory never resizes.
static mut ENGINE: *mut Engine=std::ptr::null_mut();
unsafe fn engine()->&'static mut Engine {&mut *ENGINE}
#[no_mangle] pub extern "C" fn engine_init() {unsafe {if !ENGINE.is_null(){drop(Box::from_raw(ENGINE));}ENGINE=Box::into_raw(Box::new(Engine::new()));}}
#[no_mangle] pub extern "C" fn mask_ptr()->*mut f32 {unsafe{engine().mask.as_mut_ptr()}}
#[no_mangle] pub extern "C" fn coating_ptr()->*mut f32 {unsafe{engine().coat.as_mut_ptr()}}
#[no_mangle] pub extern "C" fn image_ptr()->*const u8 {unsafe{engine().image.as_ptr()}}
#[no_mangle] pub extern "C" fn plate_ptr()->*const u8 {unsafe{engine().plate.as_ptr()}}
#[no_mangle] pub extern "C" fn wet_ptr()->*const f32 {unsafe{engine().wet.as_ptr()}}
#[no_mangle] pub extern "C" fn dry_ptr()->*const f32 {unsafe{engine().dry.as_ptr()}}
#[no_mangle] pub extern "C" fn new_paper() {unsafe{engine().new_paper();}}
#[no_mangle] pub extern "C" fn dry_ink() {unsafe{let e=engine();for i in 0..e.wet.len(){e.dry[i]+=e.wet[i];e.wet[i]=0.;}e.render();}}
#[no_mangle] pub extern "C" fn clear_ink() {unsafe{engine().coat.fill(0.);}}
#[no_mangle] pub extern "C" fn paint_ink(x:f32,y:f32,r:f32,strength:f32,erase:u32) {unsafe{engine().paint(x,y,r,strength,erase!=0);}}
#[no_mangle] pub extern "C" fn update_plate(mode:u32,amount:f32,end:f32,angle:f32,rgb:u32) {unsafe{engine().update_plate(mode,amount,end,angle,rgb);}}
#[no_mangle] pub extern "C" fn print(pressure:f32,rough:f32,speed:f32,visc:f32,amount:f32,mode:u32,end:f32,gradient_angle:f32,peel_angle:f32,ox:i32,oy:i32,rgb:u32) {unsafe{engine().imprint(pressure.clamp(0.,1.),rough.clamp(0.,1.),speed.clamp(0.,1.),visc.clamp(0.,1.),amount.clamp(0.,1.),mode,end.clamp(0.,1.),gradient_angle,peel_angle,ox.clamp(-100,100),oy.clamp(-100,100),rgb);}}
#[no_mangle] pub extern "C" fn impression_count()->u32 {unsafe{engine().count}}

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn no_contact_no_transfer(){let mut e=Engine::new();e.mask.fill(1.);e.imprint(0.,0.5,0.4,0.6,0.55,0,0.1,0.,0.,0,0,0xbc3d32);assert!(e.wet.iter().all(|x|*x==0.));}
    #[test] fn gradient_and_depletion(){let mut e=Engine::new();e.mask.fill(1.);assert!(e.ink_at(0,0,1,0.8,0.1,0.)>e.ink_at(511,0,1,0.8,0.1,0.));let before:f32=e.coat.iter().sum();e.imprint(0.7,0.5,0.4,0.6,0.55,2,0.1,0.,0.,0,0,0xbc3d32);assert!(e.coat.iter().sum::<f32>()<before);assert!(e.wet.iter().all(|x|x.is_finite()&&*x>=0.));assert!(e.wet.iter().any(|x|*x>0.));}
}
