import pathlib
import re
import subprocess
import sys
import time
import xml.etree.ElementTree as ET


PACKAGE = 'io.github.sdumliu.momonotes'
OUTPUT = pathlib.Path('smoke-output')


def adb(*args):
    return subprocess.check_output(['adb', *args], timeout=25).decode('utf-8', errors='replace')


def shell(*args):
    return adb('shell', *args)


def wait_for(get, condition, description):
    until = time.monotonic() + 35
    while time.monotonic() < until:
        result = get()
        if condition(result):
            return result
        time.sleep(.7)
    raise AssertionError(description)


def hierarchy():
    output = shell('uiautomator', 'dump', '/sdcard/momo-smoke.xml')
    if 'dumped to:' not in output:
        return ET.Element('hierarchy')
    return ET.fromstring(shell('cat', '/sdcard/momo-smoke.xml'))


def find_node(tree, name):
    return next((node for node in tree.iter('node') if name in (
        node.get('text'), node.get('content-desc'), node.get('resource-id')
    )), None)


def click(name):
    tree = wait_for(hierarchy, lambda root: find_node(root, name) is not None, f'Missing UI element {name}')
    node = find_node(tree, name)
    left, top, right, bottom = map(int, re.findall(r'\d+', node.attrib['bounds']))
    shell('input', 'tap', str((left + right) // 2), str((top + bottom) // 2))


def window_dump():
    return re.split(r'(?=^\s+Window #\d+ Window\{)', shell('dumpsys', 'window', 'windows'), flags=re.M)


def windows():
    return [chunk for chunk in window_dump() if PACKAGE in chunk and 'ty=APPLICATION_OVERLAY' in chunk
            and 'mHasSurface=true' in chunk]


def frame_of(window):
    frame = re.search(r'\bframe=\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]', window)
    if not frame:
        raise AssertionError('Could not locate the window frame')
    return tuple(map(int, frame.groups()))


def resumed(package):
    return bool(re.search(r'(?:topResumedActivity=|mResumedActivity:).*' + re.escape(package) + r'/',
                          shell('dumpsys', 'activity', 'activities')))


def open_launcher_entry():
    print(shell('am', 'start', '-W', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER',
                '-n', PACKAGE + '/.MainActivity'))
    wait_for(lambda: resumed(PACKAGE), bool, 'The app did not reach its foreground activity')


def check_status_bar():
    status = wait_for(lambda: next((window for window in window_dump()
                      if re.match(r'\s*Window #\d+ Window\{[^\n]+ StatusBar\}:', window)
                      and 'isVisible=true' in window), ''), bool, 'The Android status bar is not visible')
    _, _, _, bottom = frame_of(status)
    assert bottom > 0, 'The Android status bar has no height'
    tree = wait_for(hierarchy, lambda root: find_node(root, '设置') is not None, 'The note toolbar is missing')
    settings = find_node(tree, '设置')
    _, top, _, _ = map(int, re.findall(r'\d+', settings.attrib['bounds']))
    assert top >= bottom, f'The note toolbar starts at {top}, within the Android status bar ending at {bottom}'


def open_floating_note():
    shell('input', 'keyevent', 'KEYCODE_HOME')
    wait_for(lambda: resumed(PACKAGE), lambda active: not active, 'The launcher did not take focus')
    for _ in range(3):
        overlays = wait_for(windows, lambda items: len(items) == 1,
                            'Pet did not become a real overlay after returning home')
        if floating_note(overlays):
            return
        # The surface can be present during the home transition before it receives touch events.
        time.sleep(1.5)
        left, top, right, bottom = frame_of(overlays[0])
        shell('input', 'tap', str((left + right) // 2), str((top + bottom) // 2))
        time.sleep(1.5)
    wait_for(windows, floating_note, 'Tapping the pet did not open a focusable system overlay')


def floating_note(items):
    return len(items) == 1 and 'NOT_FOCUSABLE' not in items[0]


def main(apk):
    shell('wm', 'size', '1080x2160')
    shell('wm', 'density', '420')
    shell('input', 'keyevent', 'KEYCODE_WAKEUP')
    shell('wm', 'dismiss-keyguard')
    print(adb('install', apk))
    adb('logcat', '-c')
    open_launcher_entry()
    check_status_bar()
    click('设置')
    # This action is visible only when the pet is enabled and permission is still pending.
    click('授予悬浮窗权限')
    wait_for(lambda: resumed('com.android.settings'), bool, 'Overlay settings did not open')
    shell('appops', 'set', PACKAGE, 'SYSTEM_ALERT_WINDOW', 'allow')
    shell('input', 'keyevent', 'KEYCODE_BACK')
    wait_for(lambda: resumed(PACKAGE), bool, 'The editor did not resume after overlay settings')
    wait_for(lambda: shell('dumpsys', 'activity', 'services', PACKAGE),
             lambda text: '.PetOverlayService' in text and 'isForeground=true' in text,
             'The pet service did not start after returning to the editor')
    open_floating_note()
    for _ in range(3):
        time.sleep(1)
        note = wait_for(windows, floating_note, 'The floating note closed before being dragged')
        left, top, _, _ = frame_of(note[0])
        shell('input', 'swipe', str(left + 194), str(top + 26), str(left + 194), str(top + 166), '600')
        moved = windows()
        if floating_note(moved) and frame_of(moved[0])[1] > top:
            break
    else:
        raise AssertionError('Dragging the note did not move the system window')
    left, top, right, bottom = frame_of(moved[0])
    shell('input', 'swipe', str(right - 24), str(bottom - 24), str(right - 105), str(bottom - 135), '650')
    resized = wait_for(windows, lambda items: floating_note(items) and frame_of(items[0])[2] < right - 30
                        and frame_of(items[0])[3] < bottom - 30, 'Dragging the corner did not resize the system window')
    saved_frame = frame_of(resized[0])
    assert saved_frame[:2] == (left, top), 'Resizing moved the upper left corner'
    open_launcher_entry()
    wait_for(windows, lambda items: not items, 'A launcher entry kept the note in a floating window')
    open_floating_note()
    restored = frame_of(wait_for(windows, floating_note, 'The resized floating note did not reopen')[0])
    assert all(abs(actual - saved) <= 3 for actual, saved in zip(restored, saved_frame)), (restored, saved_frame)
    open_launcher_entry()
    wait_for(windows, lambda items: not items, 'A launcher entry kept the note in a floating window')
    check_status_bar()
    print('PASS Android status bar stays visible and above the note toolbar on launch and after closing the overlay')
    print('PASS the pet opens a movable, resizable system overlay and both changes survive reopening')


if __name__ == '__main__':
    OUTPUT.mkdir(exist_ok=True)
    try:
        main(sys.argv[1])
    finally:
        crashes = adb('logcat', '-b', 'crash', '-d')
        print(crashes)
        (OUTPUT / 'crash.txt').write_text(crashes, encoding='utf-8')
        (OUTPUT / 'logcat.txt').write_text(adb('logcat', '-d', '-s', 'AndroidRuntime:V', 'ActivityTaskManager:I',
                                              'MomoPet:V', 'Capacitor:V', 'chromium:W'), encoding='utf-8')
        (OUTPUT / 'windows.txt').write_text(shell('dumpsys', 'window', 'windows'), encoding='utf-8')
        (OUTPUT / 'activities.txt').write_text(shell('dumpsys', 'activity', 'activities'), encoding='utf-8')
        (OUTPUT / 'services.txt').write_text(shell('dumpsys', 'activity', 'services', PACKAGE), encoding='utf-8')
        with (OUTPUT / 'screen.png').open('wb') as image:
            subprocess.run(['adb', 'exec-out', 'screencap', '-p'], stdout=image, timeout=15)
