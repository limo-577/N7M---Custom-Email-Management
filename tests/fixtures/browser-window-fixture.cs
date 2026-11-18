// Native QA fixture only. It never creates an on-screen or activating window.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

public static class BrowserWindowFixture {
  private const uint WS_EX_TOOLWINDOW = 0x00000080;
  private const uint WS_EX_NOACTIVATE = 0x08000000;
  private const uint WS_VISIBLE = 0x10000000;
  private const uint WS_OVERLAPPEDWINDOW = 0x00CF0000;
  private const uint WM_CLOSE = 0x0010, WM_DESTROY = 0x0002;
  private static int alive;
  private static IntPtr first, second;
  private static readonly WindowProc Procedure = WndProc;

  [UnmanagedFunctionPointer(CallingConvention.Winapi)]
  private delegate IntPtr WindowProc(IntPtr window, uint message, IntPtr wparam, IntPtr lparam);
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct WindowClass {
    public uint size, style;
    public WindowProc procedure;
    public int classExtra, windowExtra;
    public IntPtr instance, icon, cursor, background;
    public string menu, name;
    public IntPtr smallIcon;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct Point { public int x, y; }
  [StructLayout(LayoutKind.Sequential)]
  private struct Message {
    public IntPtr window; public uint message; public UIntPtr wparam; public IntPtr lparam;
    public uint time; public Point point; public uint privateValue;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct Rect { public int left, top, right, bottom; }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr GetModuleHandle(string name);
  [DllImport("kernel32.dll")] private static extern uint SetErrorMode(uint mode);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern ushort RegisterClassEx(ref WindowClass value);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern IntPtr CreateWindowEx(uint extended, string className, string name, uint style, int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr parameter);
  [DllImport("user32.dll")] private static extern bool DestroyWindow(IntPtr window);
  [DllImport("user32.dll")] private static extern void PostQuitMessage(int exitCode);
  [DllImport("user32.dll")] private static extern int GetMessage(out Message message, IntPtr window, uint min, uint max);
  [DllImport("user32.dll")] private static extern bool TranslateMessage(ref Message message);
  [DllImport("user32.dll")] private static extern IntPtr DispatchMessage(ref Message message);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr DefWindowProc(IntPtr window, uint message, IntPtr wparam, IntPtr lparam);
  [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr window, uint message, IntPtr wparam, IntPtr lparam);
  [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out Rect value);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);

  private static IntPtr WndProc(IntPtr window, uint message, IntPtr wparam, IntPtr lparam) {
    if (message == WM_CLOSE) { DestroyWindow(window); return IntPtr.Zero; }
    if (message == WM_DESTROY) {
      if (Interlocked.Decrement(ref alive) == 0) PostQuitMessage(0);
      return IntPtr.Zero;
    }
    return DefWindowProc(window, message, wparam, lparam);
  }
  private static bool Offscreen(IntPtr window) {
    Rect bounds;
    return GetWindowRect(window, out bounds) && bounds.right < -10000 && bounds.bottom < -10000;
  }
  [STAThread]
  private static int Main(string[] args) {
    if (args.Length != 2) return 2;
    return Run(args[0], args[1]);
  }
  public static int Run(string statusFile, string commandFile) {
    // Suppress OS crash/error dialogs too; diagnostics go only to our own file.
    SetErrorMode(0x0001 | 0x0002 | 0x8000);
    try {
      IntPtr module = GetModuleHandle(null);
      WindowClass windowClass = new WindowClass { size = (uint)Marshal.SizeOf(typeof(WindowClass)), procedure = Procedure,
        instance = module, name = "Chrome_WidgetWin_1" };
      if (RegisterClassEx(ref windowClass) == 0) throw new Exception("CLASS_REGISTRATION_FAILED");
      uint extended = WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW;
      // Explicit coordinates and styles are applied at creation, before the
      // visible bit exists. No ShowWindow, focus or taskbar API is ever called.
      first = CreateWindowEx(extended, windowClass.name, "N7M background fixture 1", WS_OVERLAPPEDWINDOW | WS_VISIBLE,
        -32000, -32000, 160, 80, IntPtr.Zero, IntPtr.Zero, module, IntPtr.Zero);
      if (first == IntPtr.Zero) throw new Exception("FIRST_WINDOW_FAILED");
      Interlocked.Increment(ref alive);
      second = CreateWindowEx(extended, windowClass.name, "N7M background fixture 2", WS_OVERLAPPEDWINDOW | WS_VISIBLE,
        -31800, -32000, 160, 80, IntPtr.Zero, IntPtr.Zero, module, IntPtr.Zero);
      if (second == IntPtr.Zero) throw new Exception("SECOND_WINDOW_FAILED");
      Interlocked.Increment(ref alive);
      // STARTUPINFO SW_HIDE can suppress the first window's WS_VISIBLE bit.
      // Make both enumerable only at the same offscreen coordinates, without
      // activation or z-order changes (NOACTIVATE | NOZORDER | SHOWWINDOW).
      const uint showOffscreen = 0x0010 | 0x0004 | 0x0040;
      if (!SetWindowPos(first, IntPtr.Zero, -32000, -32000, 160, 80, showOffscreen) ||
          !SetWindowPos(second, IntPtr.Zero, -31800, -32000, 160, 80, showOffscreen))
        throw new Exception("BACKGROUND_WINDOW_POSITION_FAILED");
      if (!Offscreen(first) || !Offscreen(second) || !IsWindowVisible(first) || !IsWindowVisible(second) ||
          GetForegroundWindow() == first || GetForegroundWindow() == second)
        throw new Exception("BACKGROUND_WINDOW_GUARD_FAILED");
      string ready = "{\"pid\":" + Process.GetCurrentProcess().Id.ToString(CultureInfo.InvariantCulture) +
        ",\"handles\":[\"" + first.ToInt64().ToString(CultureInfo.InvariantCulture) + "\",\"" +
        second.ToInt64().ToString(CultureInfo.InvariantCulture) + "\"],\"offscreen\":true,\"neverActivated\":true}";
      File.WriteAllText(statusFile, ready);
      Thread commands = new Thread(delegate() {
        while (Volatile.Read(ref alive) > 0) {
          try {
            if (File.Exists(commandFile) && File.ReadAllText(commandFile).Trim() == "close-second") {
              PostMessage(second, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
              return;
            }
          } catch { }
          Thread.Sleep(50);
        }
      });
      commands.IsBackground = true; commands.Start();
      Message message;
      int state;
      while ((state = GetMessage(out message, IntPtr.Zero, 0, 0)) > 0) { TranslateMessage(ref message); DispatchMessage(ref message); }
      return state < 0 ? 3 : 0;
    } catch (Exception error) {
      try { File.WriteAllText(statusFile + ".error", error.Message); } catch { }
      if (first != IntPtr.Zero) DestroyWindow(first);
      if (second != IntPtr.Zero) DestroyWindow(second);
      return 1;
    }
  }
}
