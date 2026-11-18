param($request)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
  if ($request.action -notin @('snapshot','tag','inspect','close')) { throw 'Invalid request' }
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
public static class N7MBrowserWindows {
  public sealed class WindowInfo {
    public string hwnd; public int pid; public string processStartedAt; public string executable;
    public string appId; public string profile;
  }
  public delegate bool EnumWindowsProc(IntPtr window, IntPtr parameter);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr window, uint command);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder name, int count);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool SetProp(IntPtr window, string name, IntPtr value);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr GetProp(IntPtr window, string name);
  [DllImport("user32.dll", SetLastError=true)] static extern bool PostMessage(IntPtr window, uint message, IntPtr wparam, IntPtr lparam);
  [StructLayout(LayoutKind.Sequential)] struct PropertyKey { public Guid format; public uint id; }
  [StructLayout(LayoutKind.Explicit, Size=24)] struct PropVariant { [FieldOffset(0)] public ushort type; [FieldOffset(8)] public IntPtr pointer; }
  [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPropertyStore {
    [PreserveSig] int GetCount(out uint count);
    [PreserveSig] int GetAt(uint index, out PropertyKey key);
    [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant value);
    [PreserveSig] int SetValue(ref PropertyKey key, ref PropVariant value);
    [PreserveSig] int Commit();
  }
  [DllImport("shell32.dll")] static extern int SHGetPropertyStoreForWindow(IntPtr window, ref Guid iid, out IPropertyStore store);
  [DllImport("ole32.dll")] static extern int PropVariantClear(ref PropVariant value);
  [DllImport("shell32.dll", CharSet=CharSet.Unicode)] static extern IntPtr CommandLineToArgvW(string command, out int argc);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  static string Property(IntPtr window, uint id) {
    IPropertyStore store = null;
    PropVariant value = new PropVariant();
    try {
      Guid iid = typeof(IPropertyStore).GUID;
      if (SHGetPropertyStoreForWindow(window, ref iid, out store) != 0 || store == null) return "";
      PropertyKey key = new PropertyKey { format = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), id = id };
      if (store.GetValue(ref key, out value) != 0 || value.type != 31 || value.pointer == IntPtr.Zero) return "";
      return Marshal.PtrToStringUni(value.pointer) ?? "";
    } catch { return ""; }
    finally { PropVariantClear(ref value); if (store != null) Marshal.ReleaseComObject(store); }
  }
  static string Profile(IntPtr window) {
    string command = Property(window, 2);
    if (command.Length == 0 || command.Length > 32767) return "";
    int count;
    IntPtr list = CommandLineToArgvW(command, out count);
    if (list == IntPtr.Zero) return "";
    try {
      for (int index=0; index<count; index++) {
        string arg = Marshal.PtrToStringUni(Marshal.ReadIntPtr(list, index * IntPtr.Size)) ?? "";
        if (arg.StartsWith("--profile-directory=", StringComparison.OrdinalIgnoreCase)) {
          string profile = arg.Substring(20);
          return Regex.IsMatch(profile, @"^[a-z\d _+-]{1,128}$", RegexOptions.IgnoreCase) ? profile : "";
        }
      }
      return "";
    } finally { LocalFree(list); }
  }
  static bool Browser(string file) {
    string name = Path.GetFileName(file);
    return name.Equals("chrome.exe", StringComparison.OrdinalIgnoreCase) || name.Equals("msedge.exe", StringComparison.OrdinalIgnoreCase) || name.Equals("brave.exe", StringComparison.OrdinalIgnoreCase) || name.Equals("firefox.exe", StringComparison.OrdinalIgnoreCase);
  }
  static bool BrowserClass(IntPtr window) {
    StringBuilder name = new StringBuilder(128);
    return GetClassName(window, name, name.Capacity) > 0 && (name.ToString() == "Chrome_WidgetWin_1" || name.ToString() == "MozillaWindowClass");
  }
  static WindowInfo Read(IntPtr window) {
    uint id;
    if (!IsWindow(window) || !BrowserClass(window) || GetWindowThreadProcessId(window, out id) == 0 || id == 0 || id > Int32.MaxValue) return null;
    using (Process process = Process.GetProcessById((int)id)) {
      string file = process.MainModule.FileName;
      if (!Browser(file)) return null;
      return new WindowInfo { hwnd = window.ToInt64().ToString(CultureInfo.InvariantCulture), pid = (int)id,
        executable = file, processStartedAt = process.StartTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture),
        appId = Property(window, 5), profile = Profile(window) };
    }
  }
  public static WindowInfo[] Snapshot() {
    List<WindowInfo> result = new List<WindowInfo>();
    EnumWindows(delegate(IntPtr window, IntPtr parameter) {
      if (result.Count >= 4096) return false;
      if (!IsWindowVisible(window) || GetWindow(window, 4) != IntPtr.Zero) return true;
      try { WindowInfo value = Read(window); if (value != null) result.Add(value); } catch { }
      return true;
    }, IntPtr.Zero);
    return result.ToArray();
  }
  static string TokenName(string token) {
    Guid parsed;
    if (!Guid.TryParseExact(token, "D", out parsed)) throw new Exception("Invalid token");
    return "N7M.ManagedBrowser." + parsed.ToString("D");
  }
  static string Match(IntPtr window, int pid, string started, string executable, string token, bool requireTag) {
    if (!IsWindow(window)) return "closed";
    uint owner;
    if (GetWindowThreadProcessId(window, out owner) == 0) return "unknown";
    if (owner != (uint)pid) return "closed";
    try {
      WindowInfo actual = Read(window);
      if (actual == null || actual.processStartedAt != started || !actual.executable.Equals(executable, StringComparison.OrdinalIgnoreCase)) return "closed";
      if (requireTag && GetProp(window, TokenName(token)) != new IntPtr(1)) return "closed";
      return "alive";
    } catch { return "unknown"; }
  }
  public static string Act(string action, string handle, int pid, string started, string executable, string token) {
    long numeric;
    if (!Int64.TryParse(handle, NumberStyles.None, CultureInfo.InvariantCulture, out numeric) || numeric <= 0 || pid <= 0 || !Browser(executable)) throw new Exception("Invalid record");
    IntPtr window = new IntPtr(numeric);
    string state = Match(window, pid, started, executable, token, action != "tag");
    if (state != "alive") return state;
    if (action == "tag") {
      if (!SetProp(window, TokenName(token), new IntPtr(1))) return "unknown";
      return Match(window, pid, started, executable, token, true);
    }
    if (action == "close") {
      // WM_CLOSE preserves the browser's own pending-download / unsaved-form
      // prompts. Do not clear the marker until a later observation sees it gone.
      return PostMessage(window, 0x0010, IntPtr.Zero, IntPtr.Zero) ? "requested" : "denied";
    }
    return "alive";
  }
}
'@ | Out-Null
  if ($request.action -eq 'snapshot') {
    $response = @{ ok=$true; windows=@([N7MBrowserWindows]::Snapshot()) }
  } else {
    $records = @($request.records)
    if ($records.Count -gt 4096) { throw 'Too many windows' }
    $results = @($records | ForEach-Object {
      @{ state=[N7MBrowserWindows]::Act([string]$request.action, [string]$_.hwnd, [int]$_.pid, [string]$_.processStartedAt, [string]$_.executable, [string]$_.token) }
    })
    $response = @{ ok=$true; results=$results }
  }
  $response | ConvertTo-Json -Depth 5 -Compress
} catch {
  @{ ok=$false; error='WINDOW_OPERATION_FAILED' } | ConvertTo-Json -Compress
  exit 1
}
