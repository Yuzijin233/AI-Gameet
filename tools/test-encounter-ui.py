"""Isolated browser contract for the complete Encounter flow."""
from time import monotonic
import re
from playwright.sync_api import sync_playwright, expect

with sync_playwright() as p:
    browser = p.chromium.launch(channel='msedge', headless=True)
    context = browser.new_context(viewport={'width': 1920, 'height': 1080})
    context.route('**/*', lambda route: route.continue_() if (
        route.request.method == 'GET' and route.request.url.startswith('http://localhost:5173/')
        and '/save/' not in route.request.url and '/api/' not in route.request.url
    ) else route.fulfill(status=404, body=''))
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto('http://localhost:5173/')
    page.locator('#setup-ok').click(timeout=20000)
    expect(page.locator('#social-act-dot')).to_have_text('2')
    page.locator('[data-page-key="social"]').click()
    page.locator('#friend-tabs [data-ftab="discover"]').click()

    expect(page.locator('.discover-tabs')).to_be_visible()
    expect(page.locator('[data-discover-mode="suggested"]')).to_have_class('is-active')
    page.locator('[data-discover-mode="encounter"]').click()
    expect(page.locator('.encounter-page')).to_be_visible()
    page.screenshot(path='.rainbot/encounter-settings.png')
    expect(page.locator('#encounter-age-output')).to_have_text('24–28 岁')
    page.locator('#encounter-age').fill('22')
    expect(page.locator('#encounter-age-output')).to_have_text('20–24 岁')
    track = page.locator('#encounter-age').evaluate("e => [e.style.getPropertyValue('--match-start'), e.style.getPropertyValue('--match-end'), getComputedStyle(e).backgroundImage]")
    assert track[0].startswith('5.4') and track[1].startswith('16.2') and 'linear-gradient' in track[2]
    page.locator('[data-encounter-gender="f"]').click()

    started = monotonic()
    page.locator('#encounter-start').click()
    expect(page.locator('.encounter-matching')).to_be_visible()
    assert page.locator('.encounter-radar span').evaluate("e => getComputedStyle(e).animationName") == 'encounter-dot'
    page.screenshot(path='.rainbot/encounter-matching.png')
    assert page.locator('.encounter-matching img').count() == 0
    page.wait_for_timeout(4700)
    assert page.locator('.encounter-person').count() == 0, 'Identity appeared before five seconds'
    expect(page.locator('.encounter-person')).to_be_visible(timeout=6500)
    elapsed = monotonic() - started
    assert elapsed >= 5 and elapsed <= 12, elapsed
    expect(page.locator('.encounter-message.is-ai')).to_be_visible(timeout=10000)
    page.screenshot(path='.rainbot/encounter-chat.png')
    age_match = re.match(r'(\d+)', page.locator('.encounter-person p').inner_text())
    assert age_match is not None
    matched_age = int(age_match.group(1))
    assert 20 <= matched_age <= 24

    for index in range(5):
        before = page.locator('.encounter-message').count()
        page.locator('#encounter-input').fill(f'这是第{index + 1}句话')
        page.locator('#encounter-send').click()
        expect(page.locator('.encounter-message')).to_have_count(before + 2, timeout=10000)
    expect(page.locator('#encounter-add')).to_be_enabled()
    progress = page.evaluate("""async () => {
      const {app}=await import('/src/ui/app.js'); const store=await import('/src/store/encounters.js');
      const session=store.listEncounterHistory(app.save)[0]; return store.encounterProgress(session);
    }""")
    assert progress['unlocked'] and progress['player'] >= 4 and progress['total'] >= 10

    page.locator('#encounter-add').click()
    expect(page.locator('#fr-note')).to_be_visible()
    page.locator('#fr-note').fill('刚才聊得不错，加个好友吧。')
    page.locator('[data-fr-ok]').click()
    expect(page.locator('#friend-input')).to_be_visible(timeout=15000)
    migrated = page.evaluate("""async () => {
      const {app}=await import('/src/ui/app.js'); const {listFriends}=await import('/src/store/friends.js');
      const friend=listFriends(app.save)[0]; return {
        chat:friend.chat.map(m=>m.text), migrated:Object.keys(friend.encounterMigrated||{}).length,
        used:Object.values(app.save.encounters.days)[0].used
      };
    }""")
    assert migrated['migrated'] == 1 and migrated['used'] == 1
    assert any('第 1 次通过「遇见」相识' in text for text in migrated['chat'])
    assert any('成为了好友' in text for text in migrated['chat'])

    # A second run exits to settings and cannot reopen that temporary chat.
    page.locator('#friend-tabs [data-ftab="discover"]').click()
    page.locator('[data-discover-mode="encounter"]').click()
    page.locator('#encounter-start').click()
    expect(page.locator('.encounter-person')).to_be_visible(timeout=11000)
    page.locator('#encounter-exit').click()
    expect(page.locator('.encounter-page')).to_be_visible()
    ended = page.evaluate("""async () => {
      const {app}=await import('/src/ui/app.js'); const {listEncounterHistory}=await import('/src/store/encounters.js');
      return listEncounterHistory(app.save)[0].status;
    }""")
    assert ended == 'ended'
    assert not errors, errors
    print(f'Encounter UI passed: delayed reveal {elapsed:.2f}s, unlock, migration, and no resume')
    browser.close()
