let observer,lastRoute;
const seen=new Set();
const preference=matchMedia('(prefers-reduced-motion: reduce)');
const boundRoots=new WeakSet();
function bindPointerLight(root){
 if(boundRoots.has(root))return;boundRoots.add(root);
 let frame=0,pending;
 root.addEventListener('pointermove',event=>{
  if(preference.matches||event.pointerType!=='mouse')return;
  const surface=event.target.closest('.stat,.ask-card,.project-card,.project-tile,.source-location-row');
  if(!surface)return;
  pending={surface,x:event.clientX,y:event.clientY};
  if(frame)return;
  frame=requestAnimationFrame(()=>{
   frame=0;const {surface,x,y}=pending;if(!surface.isConnected)return;
   const rect=surface.getBoundingClientRect();
   surface.classList.add('pointer-lit');surface.style.setProperty('--light-x',((x-rect.left)/rect.width*100).toFixed(1)+'%');surface.style.setProperty('--light-y',((y-rect.top)/rect.height*100).toFixed(1)+'%');
  });
 });
 root.addEventListener('pointerout',event=>{const surface=event.target.closest('.pointer-lit');if(surface&&!surface.contains(event.relatedTarget))surface.classList.remove('pointer-lit')});
}
function countUp(element){
 const text=element.firstChild,total=Number(text?.textContent);
 if(!text||!Number.isFinite(total)||total<1)return;
 const start=performance.now();
 const tick=now=>{if(!element.isConnected)return;if(preference.matches){text.textContent=String(total);return}const t=Math.min(1,(now-start)/850);text.textContent=String(Math.round(total*(1-(1-t)**3)));if(t<1)requestAnimationFrame(tick)};
 requestAnimationFrame(tick);
}
export function mountMotion(root,route){
 observer?.disconnect();
 bindPointerLight(root);
 if(preference.matches||!Element.prototype.animate)return;
 const main=root.querySelector('.main');
 if(lastRoute!==route){
  main?.animate([{opacity:.4,transform:'translateY(12px)'},{opacity:1,transform:'translateY(0)'}],{duration:420,easing:'cubic-bezier(.2,.75,.25,1)'});
  lastRoute=route;
 }
 observer=new IntersectionObserver(entries=>{
  let order=0;
  for(const entry of entries){
   if(!entry.isIntersecting)continue;
   const element=entry.target;observer.unobserve(element);
   const key=element.dataset.motionKey;
   if(seen.has(key))continue;
   seen.add(key);
   if(element.classList.contains('stat')){const value=element.querySelector('.stat-value');if(value)countUp(value)}
   element.animate([{opacity:0,transform:'translateY(16px)'},{opacity:1,transform:'translateY(0)'}],{duration:520,delay:Math.min(order++*45,180),easing:'cubic-bezier(.2,.75,.25,1)',fill:'backwards'});
  }
 },{threshold:.08});
 root.querySelectorAll('.stat,.project-card,.project-tile,.suggestion,.file-row,.category-row,.message,.source-location-row,.answer-body>h3,.answer-body>p').forEach((element,index)=>{
  element.dataset.motionKey=route+'|'+element.className+'|'+(element.dataset.id??element.textContent.slice(0,150))+'|'+index;
  observer.observe(element);
 });
}
preference.addEventListener('change',()=>{if(preference.matches){observer?.disconnect();document.getAnimations().forEach(animation=>animation.cancel())}});
