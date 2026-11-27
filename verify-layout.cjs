const {chromium} = require(process.env.PLAYWRIGHT_MODULE_PATH);
const assert = require('node:assert/strict');
const fs = require('node:fs');
const base = new URL('/folio/portrait-lab/', process.env.PORTRAIT_REVIEW_ORIGIN || 'http://127.0.0.1:4191/').href;
const proxy = process.env.XINKO_VALIDATION_PROXY;
const browserOptions = {channel:'chrome',headless:true,...(proxy ? {proxy:{server:proxy}} : {})};
const url = base + '?run=run-demo-selected&from=history';
const rects = async page => page.locator('.review-photo .photo-enlarge img').evaluateAll(async photos => {
  await Promise.all(photos.map(img => img.decode()));
  return photos.map(img => {
    const r = img.getBoundingClientRect();
    return {x:r.x,y:r.y,w:r.width,h:r.height,naturalRatio:img.naturalWidth/img.naturalHeight};
  });
});
const manifest = page => page.evaluate(async () => (await (await fetch('/folio/portrait-lab/api/runs/run-demo-selected')).json()).manifest);
async function inputScore(page,id,name,number) {
  await page.getByRole('spinbutton',{name:id+' '+name,exact:true}).fill(String(number));
}
async function compare(page,id,status) {
  await page.locator('[data-like="sample-'+id+'"]').click();
  await page.waitForFunction(s => document.querySelector('#aestheticComparisonMessage').textContent===s,status);
  await page.waitForFunction(()=>!document.querySelector('[data-like="sample-1"]').disabled);
}
async function saveScore(page) {
  await page.locator('#saveScores').click();
  await page.waitForFunction(()=>!document.querySelector('#artifactInspector').inert && document.querySelector('#scoreStatus').textContent==='已保存');
}
async function saveDelivery(page,status) {
  await page.locator('#savePreference').click();
  await page.waitForFunction(s=>document.querySelector('#preferenceMessage').textContent===s && document.querySelector('#savePreference').disabled,status);
}
async function exercise(page,shot) {
  const control = id => page.locator('[data-pick-photo="sample-'+id+'"]');
  const save = page.locator('#savePreference');
  const initialRects = await rects(page);
  await page.locator('[data-enlarge="sample-2"]').click();
  await page.locator('#mediaPreviewDialog[open] img').evaluate(img=>img.decode());
  await page.keyboard.press('Escape');
  await page.locator('[data-open-annotation="sample-1"]').click();
  await page.locator('#annotationDialog[open]').waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:/预览客户身份原图/}).click();
  await page.locator('#mediaPreviewDialog[open] img').evaluate(img=>img.decode());
  await page.keyboard.press('Escape');

  await inputScore(page,'B','真实自然',8.5);
  assert.ok(await control(2).isDisabled());
  await saveScore(page);
  assert.equal((await manifest(page)).artifact_reviews['sample-2'].realism_naturalness,8.5);
  await control(2).click();
  assert.equal(await save.innerText(),'确认交付 B');
  await control(1).click();
  assert.ok(await save.isDisabled());
  await control(2).click();
  assert.equal((await manifest(page)).preference.winner_artifact_id,'sample-1');
  const heart=page.locator('[data-like="sample-1"]');
  await compare(page,1,'偏好 A');
  assert.equal(await heart.getAttribute('aria-pressed'),'true');
  await compare(page,1,'未记录');
  await compare(page,2,'偏好 B');
  await compare(page,1,'偏好 A');
  await page.locator('#preferenceForm summary').click();
  await page.locator('#preferenceNotes').fill('B 更适合交付');
  await page.locator('#preferenceForm summary').click();
  assert.deepEqual(await rects(page),initialRects,'Opening tools, scoring, liking and picking must not move either photo');
  if(shot) await page.screenshot({path:'preview-unified-review.png'});
  await saveDelivery(page,'已交付 B');
  await page.reload();
  await page.locator('.quality-matrix').waitFor();
  assert.deepEqual(await rects(page),initialRects);
  assert.equal(await heart.getAttribute('aria-pressed'),'true');
  assert.equal(await control(2).getAttribute('aria-pressed'),'true');
  const saved=await manifest(page);
  assert.equal(saved.preference.winner_artifact_id,'sample-2');
  assert.equal(saved.preference.notes,'B 更适合交付');
  assert.equal(saved.aesthetic_comparisons.at(-1).outcome,'a');
  for(const side of ['B','A']){
    await inputScore(page,side,'人脸一致性',6);
    await saveScore(page);
    assert.ok(await control(side==='B'?2:1).isDisabled());
    assert.equal(await page.locator('.review-photo').count(),2);
    assert.deepEqual(await rects(page),initialRects);
  }
  assert.ok(await heart.isDisabled());
  await page.locator('#otherDelivery').selectOption('none');
  await saveDelivery(page,'全部不要');
  assert.equal((await manifest(page)).preference.decision,'none');
}
async function verifySliderReview(){
 const browser=await chromium.launch(browserOptions);
 try{
 const page=await browser.newPage({viewport:{width:1706,height:932}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const origin=base;
 let posts=0;
 page.on('request',r=>{if(r.method()==='POST'&&r.url().endsWith('/review'))posts++});
 const previewRow = page.locator('[data-open-history-review="run-demo-review"]');
 const legacyRow = page.locator('[data-open-history-review="run-demo-selected"]');
 await page.goto(origin+'?view=history');
 await page.locator('#historyPage').waitFor();
 await page.locator('#historyStatusFilter').selectOption('pending_review');
 await previewRow.waitFor();
 assert.equal(await legacyRow.isVisible(),false);
 await previewRow.click();
 await page.getByRole('slider').first().waitFor();
 console.log('sliders',await page.getByRole('slider').count(),'errors',errors);
 const read=()=>page.evaluate(async()=> (await(await fetch('/folio/portrait-lab/api/runs/run-demo-review')).json()).manifest);
 const score=(name,value)=>page.getByRole('spinbutton',{name:name+' 精确数值',exact:true}).fill(String(value));
 assert.equal(await page.locator('#artifactGallery img').count(),2);
 assert.equal(await page.locator('[data-pick-photo]:visible').count(),0);

 const nearPhotos = page.locator('#reviewCompareActions');
 const firstHeart = page.locator('[data-like="sample-1"]');
 const earlyTie = nearPhotos.getByRole('button',{name:'两张差不多',exact:true});
 assert.ok(await firstHeart.isEnabled(),'The heart must be available before any scores');
 assert.equal(await page.getByRole('button',{name:'跳过比较',exact:true}).isVisible(),false);
 await firstHeart.click();
 await page.waitForFunction(()=>document.querySelector('#aestheticComparisonMessage').textContent==='偏好 A');
 await page.reload();
 await firstHeart.waitFor();
 assert.equal(await firstHeart.getAttribute('aria-pressed'),'true');
 assert.equal(Object.keys((await read()).artifact_reviews).length,0);
 await earlyTie.click();
 await page.waitForFunction(()=>document.querySelector('#aestheticComparisonMessage').textContent==='两张差不多');
 assert.equal(await earlyTie.getAttribute('aria-pressed'),'true');
 await earlyTie.click();
 await page.waitForFunction(()=>document.querySelector('#aestheticComparisonMessage').textContent==='未记录');
 await firstHeart.click();
 await page.waitForFunction(()=>document.querySelector('#aestheticComparisonMessage').textContent==='偏好 A');

 const first=page.getByRole('slider',{name:'A 人脸一致性',exact:true});
 if (process.argv.includes('--capture')) await page.screenshot({path:'preview-early-comparison.png'});
 await first.focus();
 await page.waitForTimeout(500);
 assert.equal(posts,0);
 assert.equal(await first.getAttribute('aria-valuetext'),'待评');
 await page.keyboard.press('End');
 await page.keyboard.press('ArrowLeft');
 assert.equal(await first.getAttribute('aria-valuetext'),'9.9 分');
 assert.equal(Object.keys((await read()).artifact_reviews).length,0);
 await page.reload();
 await first.waitFor();
 assert.equal(await first.getAttribute('aria-valuetext'),'9.9 分');
 await score('A 真实自然',9);
 await score('A 风格一致',9);
 await page.getByRole('heading',{name:'质量评分',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('#reviewedCount').textContent==='1 / 2');
 assert.equal(await firstHeart.getAttribute('aria-pressed'),'true');
 await score('B 人脸一致性',8);
 await score('B 真实自然',8.5);
 await score('B 风格一致',9);
 await page.getByRole('heading',{name:'质量评分',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('#reviewCompletion').textContent.includes('已评审'));
 await page.waitForFunction(()=>!document.querySelector('[data-like="sample-1"]').disabled);
 assert.equal(posts,2);
 const a=page.locator('[data-like="sample-1"]'), b=page.locator('[data-like="sample-2"]');
 for(const [btn, label] of [[a,'未记录'],[b,'偏好 B'],[b,'未记录'],[a,'偏好 A']]) {
   await btn.click(); await page.waitForFunction(t=>document.querySelector('#aestheticComparisonMessage').textContent===t&&!document.querySelector('[data-like]').disabled,label);
 }
 const slider = page.getByRole('slider',{name:'B 风格一致',exact:true});
 const box = await slider.boundingBox();
 const beforeDrag = posts;
 await page.mouse.move(box.x+box.width*.83,box.y+box.height/2);
 await page.mouse.down();
 await page.mouse.move(box.x+box.width*.79,box.y+box.height/2);
 await page.waitForTimeout(520);
 assert.equal(posts,beforeDrag);
 await page.mouse.up();
 await page.waitForFunction(()=>document.querySelector('#scoreStatus').textContent==='评分已保存');
 assert.equal(posts,beforeDrag+1);
 if(process.argv.includes('--capture')) await page.screenshot({path:'preview-score-sliders.png'});

 await page.evaluate(()=>{
   const liveFetch=window.fetch;
   window.fetch=(path, options)=>String(path).endsWith('/review') && options?.method==='POST'
     ? Promise.reject(new Error('simulated offline')) : liveFetch(path,options);
   window.restoreScoreNetwork=()=>{window.fetch=liveFetch;};
 });
 await score('A 人脸一致性',7.9);
 await page.getByRole('heading',{name:'质量评分',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('#scoreStatus').textContent.includes('重试'));
 assert.equal(await first.getAttribute('aria-valuetext'),'7.9 分');
 assert.equal((await read()).artifact_reviews['sample-1'].face_identity_fidelity,9.9);
 await page.evaluate(()=>window.restoreScoreNetwork());
 await page.locator('#saveScores').click();
 await page.waitForFunction(()=>document.querySelector('#reviewCompletion').textContent==='已评审 · 1 张合格');
 await page.reload();
 await first.waitFor();
 assert.equal(await page.locator('#reviewCompletion').innerText(),'已评审 · 1 张合格');
 assert.equal((await read()).preference,null);
 assert.equal(await page.evaluate(async()=>{
   const {deriveHistoryRunState}=await import('/folio/portrait-lab/history-workspace.js');
   const {isWorkLibraryPending}=await import('/folio/portrait-lab/work-library-state.js');
   const row=(await(await fetch('/folio/portrait-lab/api/runs?history=active')).json()).runs.find(run=>run.run_id==='run-demo-review');
   return deriveHistoryRunState(row)+':'+isWorkLibraryPending(row);
 }), 'completed:false');
 for (const [side, scores] of [['A',[3.7,4.2,4.3]],['B',[3.8,4.2,4.1]]]) {
   await score(side+' 人脸一致性',scores[0]);
   await score(side+' 真实自然',scores[1]);
   await score(side+' 风格一致',scores[2]);
 }
 await page.getByRole('heading',{name:'质量评分',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('#reviewCompletion').textContent==='已评审 · 0 张合格');
 await page.reload();
 await first.waitFor();
 assert.ok(await a.isEnabled() && await b.isEnabled() && await earlyTie.isEnabled(),
   'Both photos must remain comparable when neither meets the score thresholds');
 assert.equal(await a.getAttribute('aria-pressed'),'true','Changing scores must preserve a saved preference');
 await compare(page,2,'偏好 B');
 await page.reload();
 await first.waitFor();
 assert.equal(await b.getAttribute('aria-pressed'),'true');
 assert.equal((await read()).preference,null);
 await earlyTie.click();
 await page.waitForFunction(()=>document.querySelector('#aestheticComparisonMessage').textContent==='两张差不多');
 await earlyTie.click();
 await page.waitForFunction(()=>document.querySelector('#aestheticComparisonMessage').textContent==='未记录');
 await page.locator('#openHistory').click();
 await page.locator('#historyPage').waitFor();
 await page.locator('#historyStatusFilter').selectOption('completed');
 await previewRow.waitFor();
 await legacyRow.waitFor();
 assert.match(await previewRow.innerText(), /2 \/ 2 已评分/);
 await page.locator('#historyStatusFilter').selectOption('pending_choice');
 assert.equal(await previewRow.isVisible(),false);
 await page.locator('#historyStatusFilter').selectOption('completed');
 await legacyRow.click();
 await page.locator('#photoChoiceBar').waitFor();
 assert.equal(await page.locator('#preferenceMessage').innerText(),'已交付 A');
 assert.deepEqual(errors,[]);
 console.log('Passed new and legacy flows, writes',posts);
 }finally{await browser.close()}
}

(async()=>{
  if (process.argv.includes('--score-flow')) { await verifySliderReview(); return; }
  const browser=await chromium.launch(browserOptions);
  const evidence=[];
  try {
    for(const viewport of [{width:1706,height:932},{width:1366,height:768},{width:390,height:844}]){
      const page=await browser.newPage({viewport,deviceScaleFactor:viewport.width===1706?1.5:1});
      try {
        const errors=[];
        page.on('pageerror',e=>errors.push(e.message));
        const result=await page.goto(url);
        assert.equal(result.status(),200);
        await page.locator('.quality-matrix').waitFor();
        assert.equal(await page.getByRole('spinbutton').count(),6);
        assert.equal(await page.locator('#reviewReferences img').count(),2);
        const [a,b]=await rects(page);
        const gallery=await page.locator('#artifactGallery').boundingBox();
        const left=a.x-gallery.x, gap=b.x-a.x-a.w, right=gallery.x+gallery.width-b.x-b.w;
        assert.ok(Math.abs(left-right)<3,'Outer gutters are asymmetric');
        assert.ok(Math.abs(a.w/a.h-a.naturalRatio)<.01 && Math.abs(b.w/b.h-b.naturalRatio)<.01);
        assert.ok(Math.abs(a.h-b.h)<1 && Math.abs(a.y-b.y)<1);
        if(viewport.width>900){
          assert.ok(gap>24 && gap>=left*.85 && gap<=left*1.6,'Unbalanced spacing');
          const footer=await page.locator('#savePreference').boundingBox();
          assert.ok(footer.y+footer.height<=viewport.height);
        }
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
        if(viewport.width===1706) await exercise(page,process.argv.includes('--capture'));
        assert.deepEqual(errors,[]);
        evidence.push({viewport,photos:[a,b],gap,left,right});
        console.log(viewport.width+' px: photo gap '+gap.toFixed(1)+', margins '+left.toFixed(1)+' / '+right.toFixed(1));
      } finally {await page.close();}
    }
    fs.writeFileSync('verification.json',JSON.stringify({desktopFlowPassed:true,layouts:evidence},null,2)+'\n');
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
