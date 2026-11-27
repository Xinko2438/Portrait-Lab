const {chromium} = require(process.env.PLAYWRIGHT_MODULE_PATH);
const assert = require('node:assert/strict');
const fs = require('node:fs');
const base = 'http://127.0.0.1:4191/folio/portrait-lab/';
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
(async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
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
