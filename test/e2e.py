"""Browser acceptance tests run against local test-only server, never claim live OAuth/AI verification."""
import json,time,traceback
from pathlib import Path
from playwright.sync_api import sync_playwright,expect
from browser_harness import make_page
HTML=make_page()
BASE='http://127.0.0.1:8765'
REPORT=Path(__file__).resolve().parent.parent/'reports'
REPORT.mkdir(exist_ok=True)
results=[]
errors=[]

def check(name,func):
    try:
        func();results.append((name,'PASS'));print('PASS',name,flush=True)
    except Exception as e:
        results.append((name,'FAIL'));errors.append((name,str(e)));print('FAIL',name,repr(e),flush=True)

def drag(page,locator,direction=1):
    box=locator.bounding_box();assert box
    x=box['x']+box['width']*.5;y=box['y']+box['height']*.5
    page.mouse.move(x,y);page.mouse.down();page.mouse.move(x+direction*122,y,steps=9);page.mouse.up()

def run():
 with sync_playwright() as p:
    browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
    context=browser.new_context(viewport={'width':390,'height':844},device_scale_factor=1,is_mobile=True,has_touch=True)
    page=context.new_page();js_errors=[]
    page.on('pageerror',lambda error:js_errors.append(str(error)))
    page.set_content(HTML,wait_until='domcontentloaded')
    check('Full-screen skeleton appears during initial load',lambda:assert_skeleton(page))
    page.locator('#skeleton').wait_for(state='detached',timeout=5000)
    check('Mobile layout and above-the-fold capture',lambda:assert_mobile(page))
    def note():
        page.locator('#capture-input').fill('思いついたメモをすぐに記録')
        page.locator('#add-btn').click()
        expect(page.locator('.item-content').filter(has_text='思いついたメモ')).to_have_count(1)
        assert page.locator('#capture-input').input_value()==''
    check('Create note without sign-in',note)
    check('Local persistence after reload',lambda:assert_persist(page,'思いついたメモをすぐに記録'))
    def draft():
        page.locator('#capture-input').fill('途中のメモ')
        page.set_content(HTML);page.locator('#skeleton').wait_for(state='detached');assert page.locator('#capture-input').input_value()=='途中のメモ'
        page.locator('#capture-input').fill('')
    check('Draft survives browser reload',draft)
    def task():
        page.locator('#mode-task').click()
        page.locator('#capture-input').fill('研究を25分進める')
        page.locator('#add-btn').click()
        expect(page.locator('.item-card').filter(has_text='研究を25分進める')).to_have_count(1)
        assert page.locator('.item-card').filter(has_text='研究を25分進める').locator('.status-pill').inner_text()=='未着手'
    check('Create task and initial todo status',task)
    def swipe_forward():
        target=page.locator('.item-card').filter(has_text='研究を25分進める');drag(page,target,1)
        expect(page.locator('.item-card').filter(has_text='研究を25分進める').locator('.status-pill')).to_have_text('進行中')
        drag(page,page.locator('.item-card').filter(has_text='研究を25分進める'),1)
        expect(page.locator('.item-card').filter(has_text='研究を25分進める').locator('.status-pill')).to_have_text('完了')
    check('Swipe right todo → doing → done',swipe_forward)
    def swipe_backward():
        drag(page,page.locator('.item-card').filter(has_text='研究を25分進める'),-1)
        expect(page.locator('.item-card').filter(has_text='研究を25分進める').locator('.status-pill')).to_have_text('進行中')
    check('Swipe left reverses task status',swipe_backward)
    def native_touch_swipe():
        session=context.new_cdp_session(page)
        locator=page.locator('.item-card').filter(has_text='研究を25分進める')
        rect=locator.bounding_box();x=rect['x']+rect['width']*.4;y=rect['y']+rect['height']*.5
        def gesture(direction):
            session.send('Input.dispatchTouchEvent',{'type':'touchStart','touchPoints':[{'x':x,'y':y,'id':1}]})
            for step in range(1,10):
                session.send('Input.dispatchTouchEvent',{'type':'touchMove','touchPoints':[{'x':x+direction*15*step,'y':y,'id':1}]})
            session.send('Input.dispatchTouchEvent',{'type':'touchEnd','touchPoints':[]})
        gesture(1)
        expect(locator.locator('.status-pill')).to_have_text('完了')
        gesture(-1)
        expect(page.locator('.item-card').filter(has_text='研究を25分進める').locator('.status-pill')).to_have_text('進行中')
    check('Native touch events change status in both directions',native_touch_swipe)
    def filter_test():
        page.locator('[data-filter="doing"]').click()
        expect(page.locator('.item-card')).to_have_count(1)
        page.locator('[data-filter="note"]').click()
        expect(page.locator('.item-card')).to_have_count(1)
        page.locator('[data-filter="all"]').click()
    check('Status and note filters',filter_test)
    def edit_task():
        page.locator('.item-card').filter(has_text='研究を25分進める').click()
        expect(page.locator('#dialog-backdrop')).to_be_visible()
        page.locator('#edit-content').fill('研究を50分進める')
        page.locator('#edit-date').fill('2026-10-25')
        page.locator('#edit-status').select_option('done')
        page.locator('#dialog-save').click()
        expect(page.locator('.item-card').filter(has_text='研究を50分進める')).to_have_count(1)
        expect(page.locator('.item-card').filter(has_text='研究を50分進める').locator('.due-pill')).to_have_text('期限 2026/10/25')
    check('Edit task text, due date, status',edit_task)
    def search():
        page.locator('#search-toggle').click();page.locator('#search-input').fill('50分');expect(page.locator('.item-card')).to_have_count(1)
        page.locator('#search-input').fill('なし');expect(page.locator('#empty-state')).to_be_visible()
        page.locator('#search-clear').click()
    check('Search and empty state',search)
    def deletion():
        page.locator('.item-card').filter(has_text='研究を50分進める').click();page.locator('#dialog-delete').click()
        expect(page.locator('.item-card').filter(has_text='研究を50分進める')).to_have_count(0)
        page.locator('#toast button').click();expect(page.locator('.item-card').filter(has_text='研究を50分進める')).to_have_count(1)
    check('Delete and undo',deletion)
    def safety():
        page.locator('#mode-note').click();page.locator('#capture-input').fill('<img src=x onerror=alert(1)>')
        page.locator('#add-btn').click()
        assert page.locator('img[onerror]').count()==0
        expect(page.locator('.item-content').filter(has_text='<img src=x')).to_have_count(1)
    check('User content is escaped (XSS prevention)',safety)
    check('No JavaScript exceptions during mobile flows',lambda:assert_no_errors(js_errors))
    def quota_navigation():
        # Settings is a separate screen; we never crowd the quick-capture homepage.
        assert page.locator('#quota-cards').is_hidden()
        page.locator('#capture-input').fill('下書きのまま画面を移動')
        page.locator('#settings-btn').click()
        expect(page.locator('#settings-view')).to_be_visible()
        expect(page.locator('#home-view')).to_be_hidden()
        page.locator('#settings-usage').click()
        expect(page.locator('#usage-view')).to_be_visible()
        expect(page.locator('.quota-card')).to_have_count(4)
        # No Cloudflare token/session: missing bars must remain unknown.
        assert page.locator('.quota-state').all_inner_texts() == ['未取得'] * 4
        assert page.locator('.quota-value').count() == 0
        assert page.locator('.quota-meter-fill').evaluate_all('(els)=>els.every(e=>e.style.width === "0%")')
        page.screenshot(path=str(REPORT/'noto-usage-mobile.png'),full_page=True)
        page.locator('#usage-back').click()
        expect(page.locator('#settings-view')).to_be_visible()
        page.locator('#settings-back').click()
        expect(page.locator('#home-view')).to_be_visible()
        assert page.locator('#capture-input').input_value()=='下書きのまま画面を移動'
        page.locator('#capture-input').fill('')
    check('Settings → usage screen → back preserves unsaved note',quota_navigation)
    def system_back():
        page.locator('#settings-btn').click()
        page.locator('#settings-usage').click()
        page.go_back(wait_until='domcontentloaded')
        expect(page.locator('#settings-view')).to_be_visible()
        page.locator('#settings-back').click()
    # Browser back on about:blank is restricted in this harness; URL routing is tested separately.
    page.screenshot(path=str(REPORT/'mizu-mobile.png'),full_page=True)
    def no_overflow():
        assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth+1')
    check('Mobile layout has no horizontal overflow',no_overflow)
    # Desktop reload and keyboard shortcut
    desk=browser.new_context(viewport={'width':1440,'height':900})
    dp=desk.new_page();dp.set_content(HTML);dp.locator('#skeleton').wait_for(state='detached')
    def desktop():
        expect(dp.locator('#capture-input')).to_be_visible()
        assert dp.evaluate('document.activeElement.id')=='capture-input'
        dp.locator('#capture-input').fill('ショートカット保存')
        dp.keyboard.press('Control+Enter');expect(dp.locator('.item-content').filter(has_text='ショートカット保存')).to_have_count(1)
    check('Desktop autofocus and Ctrl+Enter to capture',desktop)
    dp.screenshot(path=str(REPORT/'mizu-desktop.png'),full_page=True)
    # Mocked cloud login and AI integration: verify frontend exchange ONLY
    cloud_ctx=browser.new_context(viewport={'width':390,'height':844},is_mobile=True,has_touch=True)
    cp=cloud_ctx.new_page();cp.set_content(HTML);cp.locator('#skeleton').wait_for(state='detached')
    def guest_merge():
        cp.locator('#capture-input').fill('提出資料を確認してゼミを準備する')
        cp.locator('#add-btn').click()
        cp.evaluate('window.__mockAuthenticated=true');cp.set_content(HTML);cp.locator('#skeleton').wait_for(state='detached')
        expect(cp.locator('#sync-label')).to_have_text('クラウドに同期')
        expect(cp.locator('.item-content').filter(has_text='提出資料')).to_have_count(1)
        cp.set_content(HTML);cp.locator('#skeleton').wait_for(state='detached');expect(cp.locator('.item-content').filter(has_text='提出資料')).to_have_count(1)
    check('Guest notes synchronize to mocked signed-in API',guest_merge)
    def ai_flow():
        cp.locator('.item-card').filter(has_text='提出資料').click()
        cp.locator('#ai-button').click()
        expect(cp.locator('.ai-suggestion')).to_have_count(2)
        cp.locator('.ai-suggestion').first.locator('button').click()
        cp.locator('#dialog-close').click()
        expect(cp.locator('.item-content').filter(has_text='資料を確認する')).to_have_count(1)
    check('Mocked Workers AI response creates a task',ai_flow)
    def logout_test():
        cp.locator('#account-btn').click()
        expect(cp.locator('#google-btn-label')).to_have_text('ログアウト')
        cp.locator('#google-signin').click()
        expect(cp.locator('#sync-label')).to_have_text('この端末に保存')
    check('Sign out returns to guest storage',logout_test)
    # Offline API fallback
    off=browser.new_context(viewport={'width':375,'height':812});op=off.new_page()
    op.set_content(HTML);op.evaluate('window.__offlineMock=true');op.set_content(HTML);op.locator('#skeleton').wait_for(state='detached')
    def offline():
        op.locator('#capture-input').fill('API停止中でも保存')
        op.locator('#add-btn').click()
        op.set_content(HTML);op.locator('#skeleton').wait_for(state='detached')
        expect(op.locator('.item-content').filter(has_text='API停止中でも保存')).to_have_count(1)
    check('API outage does not block local note capture',offline)
    def manual_theme():
        # Toggle without settings dialog, and retain preference after reload.
        assert dp.locator('html').get_attribute('data-theme')=='light'
        dp.locator('#theme-toggle').click()
        expect(dp.locator('html')).to_have_attribute('data-theme','dark')
        assert dp.locator('meta[name="theme-color"]').get_attribute('content')=='#111827'
        assert dp.evaluate('getComputedStyle(document.documentElement).colorScheme')=='dark'
        dp.set_content(HTML);dp.locator('#skeleton').wait_for(state='detached')
        expect(dp.locator('html')).to_have_attribute('data-theme','dark')
        dp.locator('#theme-toggle').click()
        expect(dp.locator('html')).to_have_attribute('data-theme','light')
    check('Manual dark mode and light mode persist across reload',manual_theme)
    def os_theme():
        darkctx=browser.new_context(viewport={'width':390,'height':844},is_mobile=True,has_touch=True,color_scheme='dark')
        darkpage=darkctx.new_page()
        darkpage.set_content(HTML);darkpage.locator('#skeleton').wait_for(state='detached')
        expect(darkpage.locator('html')).to_have_attribute('data-theme','dark')
        assert darkpage.evaluate('document.documentElement.scrollWidth <= window.innerWidth+1')
        assert darkpage.evaluate('getComputedStyle(document.querySelector(".item-card")||document.querySelector(".capture-panel")).backgroundColor')!='rgba(0, 0, 0, 0)'
        darkpage.locator('#capture-input').fill('暗い画面でもすぐにメモ')
        darkpage.locator('#add-btn').click()
        expect(darkpage.locator('.item-card')).to_have_count(1)
        darkpage.screenshot(path=str(REPORT/'mizu-dark-mobile.png'),full_page=True)
        darkctx.close()
    check('Android-style dark OS preference, capture and no overflow',os_theme)
    def remote_refresh():
        cp.evaluate('window.__mockAuthenticated=true')
        cp.set_content(HTML);cp.locator('#skeleton').wait_for(state='detached')
        cp.evaluate('window.__cloudItems.set("a1111111-1111-4111-8111-111111111111",{id:"a1111111-1111-4111-8111-111111111111",kind:"note",content:"別端末で追加したメモ",status:"todo",dueDate:null,createdAt:"2026-10-18T11:00:00.000Z",updatedAt:"2026-10-18T11:00:00.000Z"})')
        cp.locator('#sync-refresh').click()
        expect(cp.locator('.item-content').filter(has_text='別端末で追加したメモ')).to_have_count(1)
    check('Cross-device new item appears after sync refresh',remote_refresh)
    def queued_offline():
        cp.evaluate('window.__offlineWrites=true')
        cp.locator('#capture-input').fill('圏外で追加するタスク')
        cp.locator('#mode-task').click();cp.locator('#add-btn').click()
        expect(cp.locator('.item-content').filter(has_text='圏外で追加するタスク')).to_have_count(1)
        cp.wait_for_timeout(400)
        expect(cp.locator('#sync-label')).to_contain_text('未同期')
        cp.set_content(HTML);cp.locator('#skeleton').wait_for(state='detached')
        expect(cp.locator('.item-content').filter(has_text='圏外で追加するタスク')).to_have_count(1)
        cp.evaluate('window.__offlineWrites=false')
        cp.locator('#sync-refresh').click()
        expect(cp.locator('#sync-label')).to_have_text('クラウドに同期')
        assert cp.evaluate('Array.from(window.__cloudItems.values()).some(x=>x.content==="圏外で追加するタスク")')
    check('Offline outbox survives reload and manual retry in Chromium',queued_offline)
    op.close();cp.close();dp.close();page.close();browser.close()

def assert_skeleton(page):
    assert page.locator('#skeleton').is_visible()
    assert page.locator('#skeleton').evaluate('el => getComputedStyle(el).position')=='fixed'

def assert_mobile(page):
    expect(page.locator('#capture-input')).to_be_visible()
    expect(page.locator('.mobile-dock')).to_be_visible()
    assert page.locator('#capture-input').bounding_box()['y'] < 550

def assert_persist(page,needle):
    page.set_content(HTML);page.locator('#skeleton').wait_for(state='detached')
    expect(page.locator('.item-content').filter(has_text=needle)).to_have_count(1)

def assert_no_errors(errors):assert not errors,errors

if __name__=='__main__':
 try:run()
 except Exception as e:errors.append(('Test runner',repr(e)));traceback.print_exc()
 (REPORT/'browser-tests.json').write_text(json.dumps({'passed':sum(x[1]=='PASS' for x in results),'failed':sum(x[1]=='FAIL' for x in results),'results':results,'errors':errors,'test_type':'Chromium DOM test of inlined production HTML/CSS/JS with test-only mock localStorage and API; real URL navigation blocked by system policy'},ensure_ascii=False,indent=2))
 print('RESULT',json.dumps({'passed':sum(x[1]=='PASS' for x in results),'failed':sum(x[1]=='FAIL' for x in results),'errors':errors},ensure_ascii=False),flush=True)
 if errors:exit(1)
