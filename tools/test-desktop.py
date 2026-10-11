"""Desktop integration check: python tools/test-desktop.py (Playwright + Edge, localhost:5173).

Uses a fresh browser context and blocks ALL writes, save reads and model requests.
Screenshots go to the existing .rainbot directory; never touches the player's save.
"""
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / '.rainbot'
assert OUT.is_dir(), 'Expected existing .rainbot screenshot directory'

with sync_playwright() as p:
    browser = p.chromium.launch(channel='msedge', headless=True)
    ctx = browser.new_context(viewport={'width': 1920, 'height': 1080}, device_scale_factor=1)
    ctx.route('**/*', lambda r: r.continue_() if (
        r.request.method == 'GET' and r.request.url.startswith('http://localhost:5173/')
        and '/save/' not in r.request.url and '/api/' not in r.request.url
    ) else r.fulfill(status=404, body=''))
    page = ctx.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.goto('http://localhost:5173/')
    assert page.evaluate("async () => typeof (await import('/src/ui/titleBadge.js')).titleBadgeHTML") == 'function'
    page.locator('#setup-ok').click(timeout=20000)
    page.wait_for_timeout(3000)

    def nav(key):
        if key in ['friends', 'discover', 'groups', 'moments']:
            page.locator('[data-page-key="social"]').click()
            page.locator(f'#friend-tabs [data-ftab="{key}"]').click()
        else:
            page.locator(f'[data-page-key="{key}"]').click()
        expect(page.locator('#screen-lobby')).to_have_attribute('data-page', key)

    def beans():
        return page.evaluate("async () => (await import('/src/ui/app.js')).app.save.beans")

    def snapshot(name):
        page.screenshot(path=str(OUT / f'desktop-{name}.png'))

    for width, height in [(1280, 720), (1920, 1080), (2560, 1440)]:
        page.set_viewport_size({'width': width, 'height': height})
        nav('home')
        box = page.locator('#screen-lobby').bounding_box()
        assert box is not None
        assert abs(box['width'] - width) < 2 and abs(box['height'] - height) < 2, box
        game_geometry = None
        for game in ['ddz', 'fishing', 'gomoku']:
            page.locator(f'#game-{game}').click()
            assert page.locator('[data-room-go]').count() == 3
            metrics = page.locator('.lobby-main').evaluate('(e) => [e.scrollWidth-e.clientWidth,e.scrollHeight-e.clientHeight]')
            assert metrics[0] <= 2 and metrics[1] <= 2, (width, game, metrics)
            geometry = page.locator('.lobby-main').evaluate('(e) => [...e.children].map(n => {const r=n.getBoundingClientRect();return [r.y,r.height]})')
            if game_geometry is None:
                game_geometry = geometry
            assert geometry == game_geometry, (game, geometry, game_geometry)
        page.locator('#game-ddz').click()
        snapshot(f'home-{height}')
        reference = None
        for key in ['friends', 'discover', 'groups', 'moments', 'rank', 'shop', 'activity', 'mail', 'settings', 'profile']:
            nav(key)
            pane = page.locator('#desktop-page-host > #panel-layer > .drawer')
            expect(pane).to_be_visible()
            rect = pane.bounding_box()
            assert rect is not None
            if reference is None:
                reference = rect
            assert reference is not None
            assert all(abs(rect[k] - reference[k]) < 2 for k in ['x', 'y', 'width', 'height']), (key, rect, reference)
            assert rect['y'] + rect['height'] <= height + 1
            assert rect['x'] + rect['width'] <= width + 1
            if height == 1080 and key in ['activity', 'friends', 'profile']:
                snapshot(f'{key}-{height}')
        print(f'PASS {width}x{height}: home games and ten fixed-size pages')

    page.set_viewport_size({'width': 1920, 'height': 1080})
    nav('profile')
    expect(page.locator('[data-prof-pane="basic"]')).to_be_visible()
    expect(page.locator('.prof-titles .prof-title')).to_have_count(17)
    expect(page.locator('.prof-preview-sub .title-badge .title-emblem')).to_be_visible()
    page.locator('#prof-rename').click()
    expect(page.locator('#screen-lobby')).to_have_attribute('data-page', 'profile')
    expect(page.locator('#prof-name-editor')).to_be_visible()
    page.locator('#prof-name-cancel').click()
    page.locator('.prof-title [data-title="t_poor"]').click()
    assert page.evaluate("async () => (await import('/src/ui/app.js')).app.save.titles.equipped") == 't_poor'
    snapshot('profile-basic-final')
    page.locator('[data-prof-tab="decor"]').click()
    expect(page.locator('.prof-genders')).to_be_hidden()
    expect(page.locator('.prof-frames')).to_be_visible()
    snapshot('profile-decor-final')
    page.evaluate("async () => (await import('/src/ui/app.js')).app.save.cosmetics.frames.push('f_gold')")
    nav('profile')
    page.locator('[data-prof-tab="decor"]').click()
    page.locator('[data-frame="f_gold"]').click()
    expect(page.locator('.social-account-face .avatar-frame-art')).to_be_visible()
    nav('rank')
    expect(page.locator('.rank-avatar .avatar-frame-art[data-frame="f_gold"]')).to_be_visible()
    snapshot('rank-equipped-frame')
    nav('profile')
    page.locator('[data-prof-tab="decor"]').click()
    assert 'card-back-midnight.svg' in (page.locator('[data-back="back_03"] .prof-back-face').get_attribute('style') or '')
    assert page.evaluate("async () => (await import('/src/ui/cardsView.js')).probeTexture('/assets/ui/card-back-midnight.svg')")
    expect(page.locator('.prof-back[data-back="back_01"]')).to_contain_text('松影纹章')
    nav('shop')
    card_size = None
    for category in ['beans', 'titles', 'items', 'gifts', 'looks']:
        page.locator(f'.shop-tab[data-tab="{category}"]').click()
        expect(page.locator('#shop-body')).to_have_attribute('data-shop-kind', category)
        assert page.locator('.shop-tab.is-active').get_attribute('data-tab') == category
        page.wait_for_timeout(200)
        dimensions = page.locator('#shop-body .shop-item').evaluate_all('(es)=>es.map(e=>{const r=e.getBoundingClientRect();return [r.width,r.height]})')
        assert dimensions
        if card_size is None:
            card_size = dimensions[0]
        assert all(abs(size[0]-card_size[0]) < 2 and abs(size[1]-card_size[1]) < 2 for size in dimensions), (category, dimensions, card_size)
        snapshot(f'shop-unified-{category}')
    page.locator('.shop-tab[data-tab="items"]').click()
    expect(page.locator('#shop-body .asset-art')).to_have_count(5)
    snapshot('shop-items-final')
    assert page.evaluate("""async () => {
      const xml = new DOMParser().parseFromString(await (await fetch('/assets/ui/item-art.svg')).text(), 'image/svg+xml');
      return !xml.querySelector('parsererror') && xml.querySelectorAll('symbol').length === 32;
    }""")

    # Cancel leaves the underlying settings page and form untouched.
    nav('settings')
    page.locator('#btn-reset-save').click()
    page.keyboard.press('Escape')
    expect(page.locator('#set-bgm')).to_be_visible()
    expect(page.locator('.confirm-overlay')).to_have_count(0)

    nav('shop')
    before = beans()
    buy = page.locator('[data-buy]').first
    buy.click()
    page.wait_for_timeout(1600)
    assert beans() == before, 'No auto-payment before confirmation'
    expect(page.locator('[data-pay-start]')).to_be_disabled()
    page.locator('[data-method="scan"]').click()
    snapshot('payment-method')
    page.locator('[data-pay-start]').click()
    page.locator('[data-pay-stage] [data-pay-cancel]').click()
    page.wait_for_timeout(1400)
    assert beans() == before, 'Cancelled processing must never credit rewards'
    expect(buy).to_be_enabled()
    expect(page.locator('#screen-lobby')).to_have_attribute('data-page', 'shop')

    # A retained DOM reference firing twice still cannot double-submit.
    buy.click()
    page.locator('[data-method="card"]').click()
    page.locator('[data-pay-start]').evaluate('(e) => { e.click(); e.click(); }')
    expect(page.locator('.pay-result')).to_be_visible()
    assert beans() == before + 6000
    assert '未提供' not in page.locator('.pay-order').inner_text()
    snapshot('payment-success')
    page.locator('[data-pay-stage] [data-pay-cancel]').click()
    assert '26,000' in page.locator('.shop-wallet b').inner_text()

    # Navigation/programmatic close during processing cancels the timer and callback once.
    page.evaluate("""async () => {
      const panels = await import('/src/ui/panels.js');
      const {app} = await import('/src/ui/app.js');
      window.paymentProbe = {paid: 0, done: 0};
      panels.runMockPayment(app, {name:'回归测试',price:1,amountText:'不发放奖励',onPaid:()=>{
        window.paymentProbe.paid++; return {ok:true};
      }}, () => window.paymentProbe.done++);
    }""")
    page.locator('[data-method="card"]').click()
    page.locator('[data-pay-start]').click()
    page.evaluate("async () => (await import('/src/ui/panels.js')).closePanel()")
    page.wait_for_timeout(1400)
    assert page.evaluate('window.paymentProbe') == {'paid': 0, 'done': 1}
    assert page.locator('[inert]').count() == 0

    # Failed fulfillment stays failure, never success and no automatic retry.
    nav('shop')
    page.evaluate("""async () => {
      const panels = await import('/src/ui/panels.js'); const {app} = await import('/src/ui/app.js');
      window.paymentProbe = {paid:0,done:0};
      panels.runMockPayment(app,{name:'已售罄的测试商品',price:1,amountText:'不发放奖励',onPaid:()=>{
        window.paymentProbe.paid++; return {ok:false,error:'商品已售罄'};
      }},()=>window.paymentProbe.done++);
    }""")
    page.locator('[data-method="scan"]').click()
    page.locator('[data-pay-start]').click()
    expect(page.locator('.pay-fail-emoji')).to_be_visible()
    page.keyboard.press('Escape')
    assert page.evaluate('window.paymentProbe') == {'paid': 1, 'done': 1}
    assert beans() == before + 6000
    print('PASS payment: confirmation, choice, cancellation, single commit, failure, wallet refresh')

    # Switch actual saved theme via UI, keeping the same mounted profile instance.
    nav('profile')
    page.locator('[data-prof-tab="decor"]').click()
    expect(page.locator('[data-prof-pane="decor"]')).to_be_visible()
    page.locator('.prof-theme[data-theme="th_dark"]').click()
    expect(page.locator('body > #panel-layer')).to_be_visible()
    expect(page.locator('#desktop-page-host')).to_be_hidden()
    page.locator('#panel-layer [data-close]').click()
    expect(page.locator('.topbar')).to_be_visible()
    expect(page.locator('.bottom-nav')).to_be_visible()
    snapshot('classic-dark')
    page.locator('#btn-lobby-avatar').click()
    page.locator('[data-prof-tab="decor"]').click()
    page.locator('.prof-theme[data-theme="th_social"]').click()
    expect(page.locator('#desktop-page-host > #panel-layer')).to_be_visible()

    # Grant existing paid light theme only in this isolated test save, then use normal UI.
    page.evaluate("""async () => {
      const {app} = await import('/src/ui/app.js');
      app.save.cosmetics.themes.push('th_light');
    }""")
    nav('profile')
    page.locator('[data-prof-tab="decor"]').click()
    page.locator('.prof-theme[data-theme="th_light"]').click()
    expect(page.locator('html')).to_have_attribute('data-theme', 'light')
    page.locator('#panel-layer [data-close]').click()
    expect(page.locator('.topbar')).to_be_visible()
    page.locator('#nav-shop').click()
    classic_box = page.locator('#panel-layer > .drawer').bounding_box()
    assert classic_box is not None and classic_box['width'] < 800
    page.locator('#panel-layer [data-close]').click()
    page.locator('#btn-lobby-avatar').click()
    page.locator('[data-prof-tab="decor"]').click()
    page.locator('.prof-theme[data-theme="th_social"]').click()
    nav('home')
    for _ in range(3):
        nav('friends')
        nav('groups')
        nav('home')
    assert page.evaluate("async () => (await import('/src/ui/app.js')).app.friendRenderers.size") == 0
    print('PASS classic dark/light, live theme changes, renderer cleanup')

    # Real room invitations and message log; seed only the isolated browser's save.
    page.evaluate("""async () => {
      const {app}=await import('/src/ui/app.js'); const {addFriend}=await import('/src/store/friends.js');
      const {PERSONAS}=await import('/src/data/personas.js');
      for(const id of ['p01','p02','p03']) addFriend(app.save,PERSONAS.find(p=>p.id===id));
    }""")
    page.evaluate("""async () => {
      const {app}=await import('/src/ui/app.js'); const {findFriend}=await import('/src/store/friends.js');
      const f=findFriend(app.save,'p01'); const now=Date.now();
      f.chat=[{role:'ai',text:'第一条消息',at:now-2000},{role:'ai',text:'第二条消息',at:now-1000},{role:'me',text:'收到',at:now}];
      (await import('/src/ui/friends.js')).openFriends(app,{personaId:'p01'});
    }""")
    expect(page.locator('#friend-log .chat-row')).to_have_count(3)
    for face in page.locator('#friend-log .chat-face').all():
        expect(face).to_be_visible()
    expect(page.locator('#friend-log .self .avatar-frame-art')).to_be_visible()
    snapshot('chat-every-message-avatar')
    nav('home')
    page.evaluate("""async () => {
      const {app}=await import('/src/ui/app.js'); const {PERSONAS}=await import('/src/data/personas.js');
      app.openMatching(PERSONAS.slice(0,2),()=>app.showScreen('screen-lobby'));
    }""")
    expect(page.locator('.match-player-avatar .avatar-frame-art')).to_be_visible()
    page.wait_for_timeout(350)
    snapshot('matching-equipped-frame')
    page.locator('#screen-matching').click()
    for kind, needed in [('ddz', 2), ('fishing', 1), ('gomoku', 1)]:
        nav('home')
        page.locator(f'#game-{kind}').click()
        page.locator('label.mode-opt').filter(has=page.locator('input[value="room"]')).click()
        page.locator('[data-room-go]').first.click()
        expect(page.locator('#screen-lobby')).to_have_attribute('data-page', 'room')
        expect(page.locator('#room-start')).to_be_disabled()
        assert page.locator('.room-seat').count() == needed + 1
        page.locator('#room-friend-search').fill('不存在的昵称')
        expect(page.locator('[data-invite]')).to_have_count(0)
        page.locator('#room-friend-search').fill('')
        for friend in ['p01', 'p02'][:needed]:
            page.locator(f'[data-invite="{friend}"]').click()
        expect(page.locator('#room-start')).to_be_enabled()
        expect(page.locator('[data-invite="p03"]')).to_be_disabled()
        page.locator('#room-chat-input').fill('<b>你好</b>')
        page.locator('#room-chat-send').click()
        expect(page.locator('.room-chat-item .dm-text')).to_have_text('<b>你好</b>')
        msg_box = page.locator('.room-chat-item').bounding_box()
        heading_box = page.locator('.room-chat-heading').bounding_box()
        assert msg_box and heading_box and msg_box['y'] > heading_box['y'] + heading_box['height'] + 10
        assert page.locator('.room-chat-item .dm-text b').count() == 0
        if kind == 'ddz':
            for w, h in [(1280,720),(1920,1080),(2560,1440)]:
                page.set_viewport_size({'width':w,'height':h})
                rect=page.locator('.room-drawer').bounding_box()
                assert rect is not None and rect['x']+rect['width'] <= w+1 and rect['y']+rect['height'] <= h+1
                snapshot(f'room-social-{h}')
            page.set_viewport_size({'width':1920,'height':1080})
        page.locator('[data-kick="p01"]').click()
        expect(page.locator('#room-start')).to_be_disabled()
        page.locator('.room-summary [data-close]').click()
        assert page.evaluate("async () => (await import('/src/ui/app.js')).app.danmakuActive") is False
    print('PASS rooms: 2/3 seats, invite, full capacity, remove, search, safe chat, close cleanup')

    # Actual pointer input on the real table, paused at the human bidding decision.
    nav('home')
    page.locator('#game-ddz').click()
    page.locator('label.mode-opt').filter(has=page.locator('input[value="bot"]')).click()
    page.locator('[data-room-go]').first.click()
    expect(page.locator('#screen-table')).to_have_class('screen is-active')
    expect(page.locator('#bid-bar')).to_be_visible(timeout=20000)
    assert page.locator('#me-title .title-emblem').count() == 1
    expect(page.locator('.me-avatar-wrap .avatar-frame-art')).to_be_visible()
    page.evaluate("async () => { const {app}=await import('/src/ui/app.js'); window.testTable=app.table; app.table.stopCountdown(); }")
    page.wait_for_timeout(650)
    coords = page.locator('#hand-area > .card').evaluate_all('(cards) => cards.map(c => {const r=c.getBoundingClientRect();return {x:r.x+10,y:r.y+r.height/2}})')
    assert len(coords) >= 5

    def selected():
        return page.evaluate('window.testTable.game.hands[0].map((c,i)=>window.testTable.selected.has(c.id)?i:-1).filter(i=>i>=0)')

    def move_card(index):
        page.mouse.move(coords[index]['x'], coords[index]['y'])

    move_card(0)
    page.mouse.down()
    page.mouse.up()
    assert selected() == [0]
    page.mouse.down()
    page.mouse.up()
    assert selected() == []
    page.mouse.down()
    move_card(4)
    assert selected() == [0, 1, 2, 3, 4]
    move_card(2)
    assert selected() == [0, 1, 2], 'Backtracking must restore cards outside the current interval'
    page.mouse.up()
    move_card(1)
    page.mouse.down()
    move_card(4)
    page.mouse.up()
    assert selected() == [0], 'Starting on a selected card deselects the interval'
    move_card(4)
    page.mouse.down()
    page.evaluate("window.dispatchEvent(new Event('blur'))")
    assert page.evaluate('window.testTable.drag === null')
    page.mouse.up()
    move_card(3)
    page.mouse.down()
    page.evaluate("window.dispatchEvent(new PointerEvent('pointercancel',{pointerId:window.testTable.drag.pointerId}))")
    assert page.evaluate('window.testTable.drag === null')
    page.mouse.up()
    page.evaluate('window.testTable.selected.clear();window.testTable.syncHandSelection({silent:true})')
    page.mouse.move(10, 10)
    page.wait_for_timeout(120)
    card = page.locator('#hand-area > .card').nth(2)
    before_hover = card.bounding_box()
    move_card(2)
    page.wait_for_timeout(150)
    assert card.bounding_box() == before_hover, 'Hover must not shift the hit target'
    assert page.evaluate("""async () => {
      const {createCard}=await import('/src/ui/cardsView.js');
      return createCard({id:999,rank:16}).textContent.includes('JOKER');
    }""")
    snapshot('table-selection')
    for width, height in [(1280, 720), (1920, 1080), (2560, 1440)]:
        page.set_viewport_size({'width': width, 'height': height})
        page.wait_for_timeout(150)
        bid = page.locator('#bid-bar').bounding_box()
        hand = page.locator('#hand-area').bounding_box()
        assert bid and hand and bid['y'] > height * .6
        assert bid['y'] + bid['height'] < hand['y'] + 15, (bid, hand)
        card_boxes = page.locator('#hand-area > .card').evaluate_all('(cs)=>cs.map(c=>{const r=c.getBoundingClientRect();return [r.left,r.right,r.bottom]})')
        assert all(left >= 0 and right <= width + 1 and bottom <= height for left, right, bottom in card_boxes)
        expect(page.locator('#screen-table .felt')).to_be_hidden()
        snapshot(f'table-bid-final-{height}')
    page.set_viewport_size({'width': 1920, 'height': 1080})
    # Let the real bidding state machine reach a human playing turn, without rewriting hands.
    for _ in range(240):
        pending = page.evaluate('window.testTable.pending?.kind || ""')
        if pending == 'play':
            break
        if pending in ['bid', 'rob']:
            page.locator('#btn-bid-yes').click()
        page.wait_for_timeout(250)
    assert page.evaluate('window.testTable.pending?.kind') == 'play'
    page.evaluate('window.testTable.stopCountdown()')
    count_before = page.locator('#hand-area > .card').count()
    page.locator('#btn-hint').click()
    if page.locator('#btn-play').is_enabled():
        page.locator('#btn-play').click()
        expect(page.locator('#play-0 .card').first).to_be_visible()
        assert page.locator('#hand-area > .card').count() < count_before
    else:
        page.locator('#btn-pass').click()
        expect(page.locator('#play-0 .pass-tip')).to_be_visible()
    page.wait_for_timeout(350)
    snapshot('table-real-play-final')
    page.evaluate('window.testTable.destroy()')
    assert page.evaluate('window.testTable.drag === null')
    # Settlement presentation only: callbacks are probes, no economy writes.
    for game in ['ddz', 'fishing', 'gomoku']:
        for outcome in ['win', 'lose', 'draw'] if game != 'ddz' else ['win', 'lose']:
            page.evaluate("""async ({game,outcome}) => {
              const panels=await import('/src/ui/panels.js'); const {app}=await import('/src/ui/app.js');
              const {PERSONAS}=await import('/src/data/personas.js');
              window.resultProbe={again:0,quit:0};
              const callbacks={onAgain:()=>window.resultProbe.again++,onQuit:()=>window.resultProbe.quit++};
              const room={name:'低级场',base:10,cap:8192}; const delta=outcome==='win'?120:outcome==='lose'?-120:0;
              if(game==='ddz') panels.showResult(app,{landlordSeat:0,landlordWin:outcome==='win',multiplier:4,factors:[{label:'炸弹 ×4'}],
                deltas:[delta,-delta/2,-delta/2],beansBefore:[26000,30000,40000],beansAfter:[26000+delta,30000-delta/2,40000-delta/2],bombs:2},room,callbacks);
              if(game==='fishing') panels.showFishingResult(app,{pay:{kind:outcome,delta,diff:outcome==='win'?12:outcome==='lose'?-12:0},
                score:outcome==='win'?[32,20]:outcome==='lose'?[20,32]:[26,26],multiplier:2,room,persona:PERSONAS[8],wins:2,losses:1,...callbacks});
              if(game==='gomoku') panels.showGomokuResult(app,{winner:outcome==='win'?'player':outcome==='lose'?'ai':'draw',moves:22,room,
                persona:PERSONAS[8],wins:2,losses:1,...callbacks});
            }""", {'game': game, 'outcome': outcome})
            expect(page.locator('.result-drawer')).to_be_visible()
            if outcome == 'win':
                page.wait_for_timeout(350)
                snapshot(f'result-{game}-redesign')
            if outcome == 'win':
                page.locator('.result-actions .primary').click()
                assert page.evaluate('window.resultProbe') == {'again': 1, 'quit': 0}
            else:
                page.locator('.result-actions .ghost' if outcome == 'lose' else '.result-drawer .drawer-close').click()
                assert page.evaluate('window.resultProbe') == {'again': 0, 'quit': 1}
    for game, screen, avatar, controller in [('fishing','screen-fishing','fish-me-avatar','fishing'), ('gomoku','screen-gomoku','gmk-me-avatar','gomoku')]:
        page.evaluate("async () => (await import('/src/ui/app.js')).app.showScreen('screen-lobby')")
        nav('home')
        page.locator(f'#game-{game}').click()
        page.locator('label.mode-opt').filter(has=page.locator('input[value="bot"]')).click()
        page.locator('[data-room-go]').first.click()
        expect(page.locator(f'#{screen}')).to_have_class('screen is-active')
        expect(page.locator(f'#{avatar}').locator('..').locator('.avatar-frame-art')).to_be_visible()
        page.wait_for_timeout(350)
        snapshot(f'{game}-equipped-frame')
        page.evaluate("""async (controller) => { const {app}=await import('/src/ui/app.js'); app[controller]?.destroy?.(); }""", controller)
    assert not errors, errors
    print('PASS card clicks, drag ranges, backtracking, deselection, cancellation, stable hover; page errors:', errors)
    browser.close()
