const {chromium} = require(process.env.PLAYWRIGHT_MODULE_PATH);
const assert = require('node:assert/strict');
const fs = require('node:fs');
const origin = 'http://127.0.0.1:4191';
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
            ? '#comparisonMediaStage figure > img' : '#artifactGallery .artifact-image-wrap img');
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
        assert.deepEqual(errors,[]);
      } finally { await page.close(); }
    }
  } finally {
    fs.writeFileSync('verification.json',JSON.stringify(evidence,null,2)+'\n');
    await browser.close();
  }
})().catch(error=>{console.error(error);process.exitCode=1});
