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


def windows():
    return [chunk for chunk in re.split(r'(?=^\s+Window #\d+ Window\{)', shell('dumpsys', 'window', 'windows'), flags=re.M)
            if PACKAGE in chunk and 'ty=APPLICATION_OVERLAY' in chunk and 'mHasSurface=true' in chunk]


def frame_of(window):
    frame = re.search(r'\bframe=\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]', window)
    if not frame:
        raise AssertionError('Could not locate the overlay window frame')
    return tuple(map(int, frame.groups()))


def resumed(package):
    return bool(re.search(r'(?:topResumedActivity=|mResumedActivity:).*' + re.escape(package) + r'/',
                          shell('dumpsys', 'activity', 'activities')))


def open_launcher_entry():
    print(shell('am', 'start', '-W', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER',
                '-n', PACKAGE + '/.MainActivity'))
    wait_for(lambda: resumed(PACKAGE), bool, 'The app did not reach its foreground activity')


def main(apk):
    shell('wm', 'size', '1080x2160')
    shell('wm', 'density', '420')
    shell('input', 'keyevent', 'KEYCODE_WAKEUP')
    shell('wm', 'dismiss-keyguard')
    print(adb('install', apk))
    adb('logcat', '-c')
    open_launcher_entry()
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
    shell('input', 'keyevent', 'KEYCODE_HOME')
    overlays = wait_for(windows, lambda items: len(items) == 1, 'Pet did not become a real overlay after granting permission')
    left, top, right, bottom = frame_of(overlays[0])
    shell('input', 'tap', str((left + right) // 2), str((top + bottom) // 2))
    note = wait_for(windows, lambda items: len(items) == 1 and 'NOT_FOCUSABLE' not in items[0],
                    'Tapping the pet did not open a focusable system overlay')
    left, top, _, _ = frame_of(note[0])
    shell('input', 'swipe', str(left + 80), str(top + 25), str(left + 80), str(top + 145), '500')
    wait_for(windows, lambda items: len(items) == 1 and frame_of(items[0])[1] > top,
             'Dragging the note did not move the system window')
    open_launcher_entry()
    wait_for(windows, lambda items: not items, 'A launcher entry kept the note in a floating window')
    print('PASS the app icon opens the editor, permission return starts the pet, and the pet opens a movable overlay')


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
