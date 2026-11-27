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

async function verifyCreationActions(browser) {
  for (const viewport of [{width:1706,height:930},{width:390,height:844}]) {
    const page = await browser.newPage({viewport,deviceScaleFactor:viewport.width===1706?1.5:1});
    try {
      await page.goto(base,{waitUntil:'domcontentloaded'});
      await page.locator('.app-shell:not([inert])').waitFor();
      const example = page.getByRole('link',{name:'查看案例结果'});
      await example.waitFor();
      const layout = await example.evaluate(link => {
        const footer = document.querySelector('.task-brief-footer');
        const heading = document.querySelector('#generationSettingsHeading');
        const primary = document.querySelector('#prepareRun');
        const bounds = link.getBoundingClientRect();
        return {
          footerActions: [...footer.querySelectorAll('a[href],button')].map(action=>action.id),
          background:getComputedStyle(link).backgroundColor,
          width:bounds.width,
          headingOffset:Math.abs(bounds.y+bounds.height/2 - heading.getBoundingClientRect().y-heading.offsetHeight/2),
          beforePrimary:bounds.bottom < primary.getBoundingClientRect().top,
          fits:bounds.right <= innerWidth && bounds.left >= 0,
        };
      });
      assert.deepEqual(layout.footerActions,['prepareRun'],'Generation footer must have one action');
      assert.equal(layout.background,'rgba(0, 0, 0, 0)','Case navigation must be a text link');
      assert.ok(layout.width < 160 && layout.headingOffset < 8 && layout.beforePrimary && layout.fits,JSON.stringify(layout));
      await page.keyboard.press('Tab');
      await example.focus();
      assert.equal(await example.evaluate(link=>getComputedStyle(link).outlineStyle),'solid');
      await example.press('Enter');
      await page.waitForURL(url=>url.searchParams.get('run')==='run-demo-review');
      await page.locator('[data-capture-preview]').first().waitFor();
      console.log('Creation action hierarchy and keyboard link passed at',viewport.width);
    } finally { await page.close(); }
  }
}

async function verifyGenerationSettings(page) {
  const dialog = page.getByRole('dialog', {name:'API 生图配置'});
  const field = name => dialog.locator('[name="'+name+'"]');
  const open = () => page.locator('#openGenerationSettings').click();
  await page.goto(base);
  await open();
  const save = await dialog.getByRole('button',{name:'保存设置'}).boundingBox();
  const clear = await dialog.getByRole('button',{name:'清空'}).boundingBox();
  assert.ok(Math.abs(save.y - clear.y) < 2 && clear.x+clear.width <= save.x && save.width < 160 && clear.width < 160,
    'Settings should place compact actions in a single row');
  for (const [name, value] of Object.entries({
    model:'gpt-image-2.6', generatePath:'images/generations', editPath:'images/edits', baseUrl:'', apiKey:'', resultHosts:''
  })) {
    assert.equal(await field(name).inputValue(),value,'Unexpected initial value for '+name);
  }
  await field('baseUrl').fill('https://api.example.invalid/v1');
  await field('model').fill('custom-image-model');
  await field('generatePath').fill('');
  await field('editPath').fill('');
  await field('apiKey').fill('test-not-a-real-key');
  await dialog.getByRole('button',{name:'保存设置'}).click();
  await dialog.getByText('已在此标签页保存配置。').waitFor();
  const saved = await page.evaluate(() => JSON.parse(sessionStorage.getItem('portrait-lab.api-settings')));
  assert.equal(saved.model,'custom-image-model');
  assert.ok(!('apiKey' in saved));
  await page.reload();
  await open();
  assert.equal(await field('model').inputValue(),'custom-image-model');
  assert.equal(await field('generatePath').inputValue(),'images/generations');
  assert.equal(await field('editPath').inputValue(),'images/edits');
  assert.equal(await field('apiKey').inputValue(),'');
  await dialog.getByRole('button',{name:'清空'}).click();
  assert.equal(await field('baseUrl').inputValue(),'');
  assert.equal(await field('model').inputValue(),'gpt-image-2.6');
  assert.equal(await page.evaluate(() => sessionStorage.getItem('portrait-lab.api-settings')),null);
}

async function verifyBrowserGeneration(page) {
  const provider = 'https://images.test.invalid/v1/images/edits';
  const imageUrl = 'https://cdn.test.invalid/result.png';
  const response = await page.goto(base);
  assert.equal(response.status(),200);
  const image = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 24;
    return canvas.toDataURL('image/png').split(',')[1];
  });
  let calls = 0;
  let downloads = 0;
  await page.context().route(imageUrl, async route => {
    downloads++;
    assert.equal(route.request().headers().authorization,undefined);
    await route.fulfill({contentType:'image/png',body:Buffer.from(image,'base64'),headers:{'access-control-allow-origin':'*'}});
  });
  await page.context().route(url => url.href === provider, async route => {
    const request = route.request();
    const headers = {'access-control-allow-origin':'*','access-control-allow-methods':'POST','access-control-allow-headers':'authorization,content-type'};
    if (request.method()==='OPTIONS') return route.fulfill({status:204,headers});
    calls++;
    assert.equal(request.method(),'POST');
    assert.equal(request.headers().authorization,'Bearer local-test-key');
    const body = request.postDataBuffer().toString('latin1');
    assert.match(body,/name="model"\r\n\r\ngpt-image-2\.6/);
    assert.match(body,/name="n"\r\n\r\n2/);
    assert.match(body,/name="image\[\]"; filename="identity.png"/);
    assert.match(body,/name="image\[\]"; filename="template.png"/);
    await route.fulfill({json:{data:[{b64_json:image},{url:imageUrl}]},headers});
  });
  await page.locator('#openGenerationSettings').click();
  const dialog = page.getByRole('dialog',{name:'API 生图配置'});
  await dialog.locator('[name="baseUrl"]').fill('https://images.test.invalid/v1');
  await dialog.locator('[name="apiKey"]').fill('local-test-key');
  await dialog.getByText('更多连接设置',{exact:true}).click();
  await dialog.locator('[name="resultHosts"]').fill('cdn.test.invalid');
  await dialog.getByRole('button',{name:'保存设置'}).click();
  await dialog.getByText('已在此标签页保存配置。').waitFor();
  await dialog.getByRole('button',{name:'关闭生成设置'}).click();
  for(const name of ['identity','templates']) {
    await page.locator('#'+name).setInputFiles({name:name==='identity'?'identity.png':'template.png',mimeType:'image/png',buffer:Buffer.from(image,'base64')});
  }
  await page.locator('#apiImageCount').selectOption('2');
  await page.evaluate(() => {
    const nativeFetch = window.fetch;
    let firstSave = true;
    window.fetch = (url,options) => {
      if (String(url).endsWith('/api/generated-results') && firstSave) {
        firstSave = false;
        return Promise.resolve(Response.json({error:'local test error'},{status:503}));
      }
      return nativeFetch(url,options);
    };
  });
  const submit = page.locator('#prepareRun');
  assert.ok(await submit.isVisible(),'The public form must have a reachable generation action');
  assert.equal(calls,0);
  await submit.click();
  await page.waitForFunction(() => document.querySelector('#prepareResult').textContent.includes('可再次点击保存成片'));
  assert.equal(calls,1);
  assert.equal(downloads,1);
  await submit.click();
  try { await page.getByRole('slider').first().waitFor({timeout:10000}); }
  catch (error) { throw new Error(`Review did not open, provider calls: ${calls}, notice: ${await page.locator('#prepareResult').textContent()}`,{cause:error}); }
  assert.equal(calls,1);
  assert.equal(await page.locator('#artifactGallery img').count(),2);
  assert.ok(await page.locator('#artifactGallery img').first().evaluate(async img => { await img.decode(); return img.naturalWidth===24; }));
  await page.reload();
  await page.getByRole('slider').first().waitFor();
  assert.equal(calls,1,'Reload must never resubmit a generation request');
  assert.ok(await page.locator('#artifactGallery img').first().evaluate(async img => { await img.decode(); return img.naturalHeight===24; }));
  assert.ok(!(await page.evaluate(() => sessionStorage.getItem('portrait-lab.api-settings'))).includes('local-test-key'));

  let textCalls = 0;
  await page.context().route('https://images.test.invalid/v1/images/generations', async route => {
    const headers = {'access-control-allow-origin':'*','access-control-allow-methods':'POST','access-control-allow-headers':'authorization,content-type'};
    if (route.request().method()==='OPTIONS') return route.fulfill({status:204,headers});
    const body = route.request().postDataJSON();
    assert.match(body.prompt,/blue skyline/);
    assert.equal(body.model,'gpt-image-2.6');
    assert.deepEqual(Object.keys(body).sort(),['model','n','prompt','quality','size']);
    textCalls++;
    await route.fulfill({json:{data:[{b64_json:image}]},headers});
  });
  await page.locator('#newTaskButton').click();
  await page.locator('#openTaskOptions').click();
  await page.locator('#apiOperation').selectOption('generate');
  await page.keyboard.press('Escape');
  await page.locator('#userSupplement').fill('blue skyline');
  await page.locator('#openGenerationSettings').click();
  await dialog.locator('[name="apiKey"]').fill('local-test-key');
  await dialog.getByRole('button',{name:'保存设置'}).click();
  await dialog.getByRole('button',{name:'关闭生成设置'}).click();
  await submit.click();
  await page.getByRole('slider').first().waitFor({timeout:10000});
  assert.equal(textCalls,1);
  assert.equal(calls,1);
}

async function verifyGenerationErrors(page) {
  const provider = 'https://images.test.invalid/v1/images/generations';
  const blockedProvider = 'https://sub.200204.asia/v1/images/generations';
  const sensitiveText = 'provider-detail-must-not-appear';
  const headers = {'access-control-allow-origin':'*','access-control-allow-headers':'authorization,content-type','access-control-allow-methods':'POST'};
  let status;
  let responseBody;
  let attempts = 0;
  await page.context().route(provider, async route => {
    if (route.request().method()==='OPTIONS') return route.fulfill({status:204,headers});
    attempts++;
    if (status === 0) return route.abort('failed');
    await route.fulfill({status,body:responseBody,headers:{...headers,'content-type':'application/json'}});
  });
  await page.context().route(blockedProvider, async route => {
    if (route.request().method()==='OPTIONS') return route.fulfill({status:403});
    await route.abort('failed');
  });
  await page.goto(base,{waitUntil:'domcontentloaded'});
  const dialog = page.getByRole('dialog',{name:'API 生图配置'});
  const configure = async address => {
    await page.locator('#openGenerationSettings').click();
    await dialog.locator('[name="baseUrl"]').fill(address);
    await dialog.locator('[name="apiKey"]').fill('local-error-test-key');
    await dialog.getByRole('button',{name:'保存设置'}).click();
    await dialog.getByText('已在此标签页保存配置。').waitFor();
    await dialog.getByRole('button',{name:'关闭生成设置'}).click();
  };
  await configure('https://images.test.invalid/v1');
  await page.locator('#openTaskOptions').click();
  await page.locator('#apiOperation').selectOption('generate');
  await page.keyboard.press('Escape');
  await page.locator('#userSupplement').fill('Test image');
  const submit = page.locator('#prepareRun');
  const notice = page.locator('#prepareResult[role="status"]');
  const scenarios = [
    [401, '核对 API 密钥'],
    [403, '模型调用权限'],
    [404, '核对 API 地址和生成端点路径'],
    [429, '额度或请求频率'],
    [503, '服务商暂时不可用'],
    [0, '跨域或网络'],
    [200, '成片返回格式不兼容', '<html>' + sensitiveText + '</html>'],
    [200, '请在「图片下载域名」中加入 cdn.test.invalid', JSON.stringify({data:[{url:'https://cdn.test.invalid/result.png?private=hidden'}]})],
  ];
  for (const [code,hint,body] of scenarios) {
    status = code;
    responseBody = body ?? JSON.stringify({error:{message:sensitiveText}});
    await submit.click();
    await page.locator('#prepareResult[data-state="error"]').waitFor({timeout:10000});
    assert.ok(await notice.isVisible());
    const message = await notice.textContent();
    assert.ok(message.includes(hint),`Expected "${hint}" for ${code}, got "${message}"`);
    assert.ok(!message.includes(sensitiveText) && !message.includes('private=hidden'));
    assert.ok(await submit.isEnabled());
  }
  assert.equal(attempts,scenarios.length);
  await configure('https://sub.200204.asia/v1');
  await submit.click();
  await page.locator('#prepareResult[data-state="error"]').waitFor({timeout:10000});
  assert.match(await notice.textContent(),/三千.*跨域/);
}

(async()=>{
  if (process.argv.includes('--score-flow')) { await verifySliderReview(); return; }
  const browser=await chromium.launch(browserOptions);
  const evidence=[];
  try {
    if (process.argv.includes('--creation-layout')) {
      await verifyCreationActions(browser);
      return;
    }
    if (process.argv.includes('--generation')) {
      const page = await browser.newPage({viewport:{width:1440,height:930}});
      await verifyBrowserGeneration(page);
      console.log('Browser image generation and local review persistence passed');
      return;
    }
    if (process.argv.includes('--generation-errors')) {
      const page = await browser.newPage({viewport:{width:1440,height:930}});
      await verifyGenerationErrors(page);
      console.log('Provider errors are shown safely in the creation form');
      return;
    }
    if (process.argv.includes('--settings')) {
      const page = await browser.newPage({viewport:{width:1440,height:930}});
      await verifyGenerationSettings(page);
      console.log('Generation defaults, saved overrides and reset passed');
      return;
    }
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
