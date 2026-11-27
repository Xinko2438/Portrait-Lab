const {chromium} = require(process.env.PLAYWRIGHT_MODULE_PATH);
const assert = require('node:assert/strict');
const fs = require('node:fs');
const origin = 'http://127.0.0.1:4191';
async function verifyPhotoDecision(page) {
  const choose = side => page.locator('[data-pick-photo="'+side+'"]');
  const submit = page.locator('#savePreference');
  const read = () => page.evaluate(async () => (await (await fetch('/folio/portrait-lab/api/runs/run-demo-selected')).json()).manifest);
  const initial = await read();
  assert.equal(initial.preference.winner_artifact_id, 'sample-1');
  await page.locator('[data-enlarge="b"]').click();
  await page.locator('#mediaPreviewDialog[open] img').evaluate(image => image.decode());
  await page.keyboard.press('Escape');
  assert.equal(await choose('a').getAttribute('aria-pressed'),'true');

  await choose('b').click();
  assert.equal(await submit.textContent(),'确认交付 B');
  await choose('a').click();
  assert.equal(await submit.isDisabled(),true);
  await choose('b').click();
  assert.equal((await read()).preference.winner_artifact_id,'sample-1');
  await page.locator('#preferenceForm summary').click();
  await page.locator('#preferenceNotes').fill('B 更适合交付');
  await page.locator('[data-comparison-outcome="a"]').click();
  await page.waitForFunction(() => document.querySelector('#aestheticComparisonMessage').textContent === '更喜欢 A');
  assert.equal(await choose('b').getAttribute('aria-pressed'),'true');
  assert.equal(await page.locator('#preferenceNotes').inputValue(),'B 更适合交付');
  await page.locator('#preferenceForm summary').click();
  if (process.argv.includes('--capture')) await page.screenshot({path:'preview-photo-selection.png'});
  await submit.click();
  await page.waitForFunction(() => document.querySelector('#preferenceMessage').textContent === '已交付 B');
  await page.reload();
  await page.locator('#reviewWorkspace').waitFor();
  assert.equal(await choose('b').getAttribute('aria-pressed'),'true');
  const stored = await read();
  assert.equal(stored.preference.winner_artifact_id,'sample-2');
  assert.equal(stored.preference.notes,'B 更适合交付');
  assert.equal(stored.aesthetic_comparisons.length, initial.aesthetic_comparisons.length + 1);
  assert.equal(stored.aesthetic_comparisons.at(-1).outcome,'a');
  await page.locator('#otherDelivery').selectOption('pending');
  await submit.click();
  await page.waitForFunction(() => document.querySelector('#savePreference').textContent==='已保存');
  assert.equal((await read()).preference.decision,'pending');
  // Use this disposable visitor's copy to exercise qualification changes.
  for (const id of ['sample-1', 'sample-2']) {
    const status = await page.evaluate(async artifact => (await fetch('/folio/portrait-lab/api/runs/run-demo-selected/artifacts/' + artifact + '/review', {
      method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({faceFidelity:6,naturalness:9,style:9,notes:'',diagnosticCodes:[]})
    })).status, id);
    assert.equal(status,200);
    await page.reload();
    await page.locator('#reviewWorkspace').waitFor();
    assert.equal(await page.locator('#comparisonMediaStage:visible [data-pick-photo]:visible').count(),id==='sample-1'?1:0);
    if(id==='sample-1') {
      await page.locator('[data-pick-photo="a"]').click();
      assert.equal(await submit.innerText(),'确认交付 A');
      assert.ok((await page.locator('#comparisonPreviewALabel').innerText()).includes('候选 2'));
    }
  }
  await page.locator('#otherDelivery').selectOption('none');
  await submit.click();
  await page.waitForFunction(() => document.querySelector('#savePreference').textContent==='已保存');
  assert.equal((await read()).preference.decision,'none');
}

(async()=>{
  const browser = await chromium.launch({channel:'chrome',headless:true});
  const evidence = [];
  try {
    for (const viewport of [{width:1706,height:932},{width:1366,height:768},{width:390,height:844}]) {
      const page = await browser.newPage({viewport,deviceScaleFactor:viewport.width===1706?1.5:1});
      try {
        const errors=[];
        page.on('pageerror',error=>errors.push(error.message));
        const response = await page.goto(origin+'/folio/portrait-lab/?run=run-demo-selected&from=history');
        assert.equal(response.status(),200);
        await page.locator('#reviewWorkspace').waitFor({timeout:20000});
        let choiceReferenceUrls;
        for (const view of ['choice','score']) {
          await page.locator('[data-review-step-target="'+view+'"]').click();
          const references = page.locator('#reviewReferences');
          assert.equal(await references.isVisible(), true, 'Reference strip hidden in ' + view);
          const thumbs = references.locator('img');
          assert.equal(await thumbs.count(), 2);
          const referenceUrls = await thumbs.evaluateAll(async (images) => {
            await Promise.all(images.map(image => image.decode()));
            return images.map(image => image.currentSrc);
          });
          if (view === 'choice') choiceReferenceUrls = referenceUrls;
          else assert.deepEqual(referenceUrls, choiceReferenceUrls);
          if (viewport.width === 1706) {
            await references.getByRole('button', {name: /身份原图/}).click();
            const dialog = page.locator('#mediaPreviewDialog');
            await dialog.waitFor();
            await dialog.locator('img').evaluate(image => image.decode());
            await page.keyboard.press('Escape');
            await dialog.waitFor({state: 'hidden'});
          }
          const images = page.locator(view==='choice'
            ? '#comparisonMediaStage figure:not([hidden]) img' : '#artifactGallery .artifact-image-wrap img');
          assert.equal(await images.count(),2);
          await images.first().waitFor();
          const stats = await images.evaluateAll(async (elements, tab) => {
            await Promise.all(elements.map(image=>image.decode()));
            const rect = el => {const b=el.getBoundingClientRect(); return {x:b.x,y:b.y,width:b.width,height:b.height,right:b.right,bottom:b.bottom}};
            const box = elements[0].closest(tab==='choice'?'#comparisonMediaStage':'#artifactGallery');
            return {
              stage:rect(box),
              frames:elements.map(image=>rect(image.closest(tab==='choice'?'figure':'.artifact-candidate'))),
              photos:elements.map(image=>({...rect(image),ratio:image.naturalWidth/image.naturalHeight, fit:getComputedStyle(image).objectFit}))
            };
          },view);
          const {stage,frames,photos}=stats;
          if(process.argv.includes('--capture') && viewport.width===1706) {
            await page.screenshot({path:'preview-'+view+'-after.png'});
          }
          if(process.argv.includes('--baseline') && viewport.width===1706) {
            await page.screenshot({path:'preview-'+view+'-before.png'});
          }
          evidence.push({viewport,view,visibleReferences:referenceUrls.length,...stats});
          console.log(viewport.width,view,photos.map(p=>[Math.round(p.width),Math.round(p.height)]),frames.map(b=>Math.round(b.width)));
          {
            for(let i=0;i<2;i++) {
              const p=photos[i],f=frames[i];
              assert.equal(p.fit,'contain');
              assert.ok(Math.abs(p.width/p.height-p.ratio)<.015,'Photo still has letterboxing');
              assert.ok(f.width-p.width<6,'Frame too wide for photo');
              assert.ok(f.y>=stage.y-1 && f.bottom<=stage.bottom+1,'Frame exceeds available height');
            }
            assert.ok(Math.abs(photos[0].height-photos[1].height)<2,'Photo heights differ');
            if(viewport.width===1706) assert.ok(photos[0].height/stage.height>.84,'Photo does not use available height');
          }
          assert.ok(frames[0].right<=frames[1].x+1,'Images overlap');
          assert.ok(frames[1].right<=viewport.width+1,'Horizontal clipping');
        }
        if (viewport.width === 1706) {
          await page.locator('#artifactGallery .candidate-select').last().click();
          assert.equal(await page.locator('#artifactInspector h2').innerText(),'候选 2');
          assert.equal(await page.locator('#reviewReferences').isVisible(),true);
          await page.locator('#artifactGallery [data-open-annotation]').last().click();
          await page.locator('#annotationDialog[open]').waitFor();
          await page.keyboard.press('Escape');
          await page.locator('#annotationDialog[open]').waitFor({state:'hidden'});
        }
        if (viewport.width === 1706) {
          await page.locator('[data-review-step-target="choice"]').click();
          await verifyPhotoDecision(page);
        }
        assert.deepEqual(errors,[]);
      } finally { await page.close(); }
    }
  } finally {
    fs.writeFileSync('verification.json',JSON.stringify(evidence,null,2)+'\n');
    await browser.close();
  }
})().catch(error=>{console.error(error);process.exitCode=1});
