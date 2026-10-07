param([switch]$ValidateOnly)

$ErrorActionPreference = 'Stop'

# A private, persistent helper. Only locally approved Electron sessions can send
# input through its stdin. There are no hooks, scheduled tasks or elevated calls.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class AuraInput {
    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT { public uint type; public UNION value; }
    [StructLayout(LayoutKind.Explicit)]
    private struct UNION {
        [FieldOffset(0)] public MOUSEINPUT mouse;
        [FieldOffset(0)] public KEYBDINPUT key;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct MOUSEINPUT {
        public int dx, dy;
        public uint mouseData, flags, time;
        public UIntPtr extra;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT {
        public ushort vk, scan;
        public uint flags, time;
        public UIntPtr extra;
    }
    [DllImport("user32.dll", SetLastError=true)]
    private static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("user32.dll", SetLastError=true)]
    private static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    private static extern uint MapVirtualKey(uint code, uint mapType);

    private static HashSet<string> pressedKeys = new HashSet<string>();
    private static HashSet<int> pressedButtons = new HashSet<int>();
    private static readonly Dictionary<string, ushort> keys = new Dictionary<string, ushort> {
        {"Backspace",0x08}, {"Tab",0x09}, {"Enter",0x0D}, {"ShiftLeft",0xA0}, {"ShiftRight",0xA1},
        {"ControlLeft",0xA2}, {"ControlRight",0xA3}, {"AltLeft",0xA4}, {"AltRight",0xA5},
        {"CapsLock",0x14}, {"Escape",0x1B}, {"Space",0x20}, {"PageUp",0x21}, {"PageDown",0x22},
        {"End",0x23}, {"Home",0x24}, {"ArrowLeft",0x25}, {"ArrowUp",0x26}, {"ArrowRight",0x27},
        {"ArrowDown",0x28}, {"Insert",0x2D}, {"Delete",0x2E}, {"Semicolon",0xBA}, {"Equal",0xBB},
        {"Comma",0xBC}, {"Minus",0xBD}, {"Period",0xBE}, {"Slash",0xBF}, {"Backquote",0xC0},
        {"BracketLeft",0xDB}, {"Backslash",0xDC}, {"BracketRight",0xDD}, {"Quote",0xDE}
    };

    public static void Initialize() {
        // Cursor coordinates are physical display pixels, including negative
        // coordinates on monitors positioned left/above the primary screen.
        try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch (EntryPointNotFoundException) {}
        for (char c='A'; c<='Z'; c++) keys["Key"+c] = (ushort)c;
        for (char c='0'; c<='9'; c++) keys["Digit"+c] = (ushort)c;
    }

    public static int ValidateDefinition() {
        int expected = IntPtr.Size == 8 ? 40 : 28;
        int expectedOffset = IntPtr.Size == 8 ? 8 : 4;
        int actual = Marshal.SizeOf(typeof(INPUT));
        if (actual != expected || Marshal.OffsetOf(typeof(INPUT), "value").ToInt32() != expectedOffset)
            throw new InvalidOperationException("Invalid native INPUT structure alignment");
        return actual;
    }

    public static void AssertForeground(string expectedHandle) {
        long handle;
        if (!long.TryParse(expectedHandle, out handle) || handle <= 0 || GetForegroundWindow().ToInt64() != handle)
            throw new InvalidOperationException("The approved QA window no longer owns foreground focus");
    }

    private static void Inject(INPUT input) {
        if (SendInput(1, new INPUT[]{input}, Marshal.SizeOf(typeof(INPUT))) != 1)
            throw new InvalidOperationException("Windows refused input. Elevated applications and secure screens may be inaccessible.");
    }

    public static void Move(int x, int y) {
        if (Math.Abs((long)x)>262144 || Math.Abs((long)y)>262144) throw new ArgumentException("Invalid coordinates");
        if (!SetCursorPos(x,y)) throw new InvalidOperationException("Windows refused pointer movement");
    }

    public static void Button(int button, bool down) {
        if (button<0 || button>2) throw new ArgumentException("Invalid button");
        // Browser numbering: 0 left, 1 middle, 2 right.
        uint flags = button == 0 ? (down ? 0x0002u : 0x0004u) :
            button == 1 ? (down ? 0x0020u : 0x0040u) : (down ? 0x0008u : 0x0010u);
        INPUT input = new INPUT();
        input.type = 0; input.value.mouse.flags = flags;
        Inject(input);
        if (down) pressedButtons.Add(button); else pressedButtons.Remove(button);
    }

    public static void Key(string code, bool down) {
        ushort vk;
        if (!keys.TryGetValue(code, out vk)) throw new ArgumentException("Unsupported key");
        INPUT input = new INPUT();
        input.type=1; input.value.key.vk=vk;
        // A real scan code is needed by applications that inspect physical
        // keyboard events (including Chromium's KeyboardEvent.code).
        input.value.key.scan=(ushort)(MapVirtualKey(vk,0) & 0xFF);
        uint extended = (code.StartsWith("Arrow") || code=="Insert" || code=="Delete" || code=="Home" ||
            code=="End" || code=="PageUp" || code=="PageDown" || code=="ControlRight" || code=="AltRight") ? 1u : 0u;
        input.value.key.flags = extended | (down ? 0u : 2u);
        Inject(input);
        if (down) pressedKeys.Add(code); else pressedKeys.Remove(code);
    }

    public static void Wheel(int deltaX, int deltaY) {
        if (Math.Abs((long)deltaX)>1200 || Math.Abs((long)deltaY)>1200) throw new ArgumentException("Invalid scroll delta");
        if (deltaY!=0) {
            INPUT input=new INPUT(); input.type=0; input.value.mouse.flags=0x0800;
            input.value.mouse.mouseData=unchecked((uint)-deltaY); Inject(input);
        }
        if (deltaX!=0) {
            INPUT input=new INPUT(); input.type=0; input.value.mouse.flags=0x1000;
            input.value.mouse.mouseData=unchecked((uint)deltaX); Inject(input);
        }
    }

    public static void ReleaseAll() {
        // Attempt every release even if one application currently refuses input.
        foreach (string key in new List<string>(pressedKeys)) { try { Key(key,false); } catch {} }
        foreach (int button in new List<int>(pressedButtons)) { try { Button(button,false); } catch {} }
        pressedKeys.Clear(); pressedButtons.Clear();
    }
}
'@

[AuraInput]::ValidateDefinition() | Out-Null
if ($ValidateOnly) {
    [Console]::Out.WriteLine((@{ type='validated'; pointerBytes=[IntPtr]::Size; inputBytes=[AuraInput]::ValidateDefinition(); noInputInjected=$true } | ConvertTo-Json -Compress))
    exit 0
}
[AuraInput]::Initialize()
[Console]::Out.WriteLine('{"type":"ready","available":true}')
[Console]::Out.Flush()
try {
    while ($null -ne ($inputLine = [Console]::In.ReadLine())) {
        if ($inputLine.Length -gt 2048) { throw 'Native input command is too large' }
        $packet = $inputLine | ConvertFrom-Json
        # Used only by the isolated desktop QA harness. Production remote input
        # is unbound because the user explicitly approves ordinary desktop use.
        if ($null -ne $packet.windowId -and $packet.type -ne 'release') {
            [AuraInput]::AssertForeground([string]$packet.windowId)
        }
        switch ($packet.type) {
            'move' { [AuraInput]::Move([int]$packet.x, [int]$packet.y) }
            'down' { [AuraInput]::Move([int]$packet.x, [int]$packet.y); [AuraInput]::Button([int]$packet.button, $true) }
            'up' { [AuraInput]::Move([int]$packet.x, [int]$packet.y); [AuraInput]::Button([int]$packet.button, $false) }
            'wheel' { [AuraInput]::Wheel([int]$packet.deltaX, [int]$packet.deltaY) }
            'keydown' { [AuraInput]::Key([string]$packet.code, $true) }
            'keyup' { [AuraInput]::Key([string]$packet.code, $false) }
            'release' {
                [AuraInput]::ReleaseAll()
                $response = @{ type='ack'; id=$packet.id; ok=$true } | ConvertTo-Json -Compress
                [Console]::Out.WriteLine($response)
                [Console]::Out.Flush()
            }
            default { throw 'Unsupported native input command' }
        }
    }
} catch {
    [AuraInput]::ReleaseAll()
    # No exception details or user keystrokes are logged.
    [Console]::Out.WriteLine('{"type":"error","reason":"Native input failed; all pressed input was released"}')
    [Console]::Out.Flush()
    exit 1
} finally {
    [AuraInput]::ReleaseAll()
}
