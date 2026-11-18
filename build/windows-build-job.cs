using System;
using System.Text;
using System.Runtime.InteropServices;
using System.ComponentModel;

// Every child starts suspended and joins the job before executing any code.
// No breakaway flag is enabled. Closing this handle kills remaining descendants.
public static class N7MBuildJob {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long ProcessTime, JobTime; public uint Flags;
    public UIntPtr MinWorkingSet, MaxWorkingSet; public uint ActiveProcesses;
    public UIntPtr Affinity; public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong A,B,C,D,E,F; }
  [StructLayout(LayoutKind.Sequential)] struct Limits {
    public BasicLimits Basic; public IoCounters Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcess, PeakJob;
  }
  [StructLayout(LayoutKind.Sequential)] struct Security { public int Length; public IntPtr Descriptor; public int Inherit; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
    public int Size; public string Reserved, Desktop, Title;
    public uint X,Y,XSize,YSize,XChars,YChars,Fill,Flags;
    public short Show, ReservedSize; public IntPtr ReservedBytes, Input, Output, Error;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process, Thread; public uint Id, ThreadId; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int type, ref Limits limits, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string application, StringBuilder command, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr environment, string cwd, ref Startup startup, out ProcessInfo process);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFile(string name, uint access, uint share, ref Security security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  static string Quote(string value) {
    var result = new StringBuilder("\""); int slashes = 0;
    foreach (char c in value) {
      if (c == '\\') { slashes++; continue; }
      if (c == '"') result.Append('\\', slashes * 2 + 1);
      else result.Append('\\', slashes);
      result.Append(c); slashes = 0;
    }
    return result.Append('\\', slashes * 2).Append('"').ToString();
  }
  public static int Run(string exe, string[] args, string cwd, string stdout, string stderr, int timeout, long processMiB, long jobMiB, int cpuSeconds) {
    IntPtr job = IntPtr.Zero, output = IntPtr.Zero, error = IntPtr.Zero, input = IntPtr.Zero;
    ProcessInfo process = new ProcessInfo(); bool created = false;
    try {
      job = CreateJobObject(IntPtr.Zero, null); Check(job != IntPtr.Zero);
      var limits = new Limits();
      limits.Basic.Flags = 0x2000 | 0x8 | 0x100 | 0x200 | 0x4;
      limits.Basic.ActiveProcesses = 64; limits.Basic.JobTime = cpuSeconds * 10000000L;
      limits.ProcessMemory = new UIntPtr((ulong)processMiB * 1048576UL);
      limits.JobMemory = new UIntPtr((ulong)jobMiB * 1048576UL);
      Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(Limits))));
      var security = new Security { Length = Marshal.SizeOf(typeof(Security)), Inherit = 1 };
      output = CreateFile(stdout, 0x40000000, 1, ref security, 1, 0x80, IntPtr.Zero);
      error = CreateFile(stderr, 0x40000000, 1, ref security, 1, 0x80, IntPtr.Zero);
      input = CreateFile("NUL", 0x80000000, 1 | 2, ref security, 3, 0x80, IntPtr.Zero);
      Check(output != new IntPtr(-1) && error != new IntPtr(-1) && input != new IntPtr(-1));
      var startup = new Startup { Size = Marshal.SizeOf(typeof(Startup)), Flags = 0x100, Input = input, Output = output, Error = error };
      var command = new StringBuilder(Quote(exe)); foreach (var arg in args) command.Append(' ').Append(Quote(arg));
      Check(CreateProcess(exe, command, IntPtr.Zero, IntPtr.Zero, true, 0x08000000 | 0x4, IntPtr.Zero, cwd, ref startup, out process));
      created = true;
      Check(AssignProcessToJobObject(job, process.Process));
      Check(ResumeThread(process.Thread) != 0xffffffff);
      uint waited = WaitForSingleObject(process.Process, (uint)timeout);
      if (waited == 258) { Check(TerminateJobObject(job, 124)); WaitForSingleObject(process.Process, 10000); return 124; }
      Check(waited == 0);
      uint code; Check(GetExitCodeProcess(process.Process, out code)); return unchecked((int)code);
    } finally {
      // Also clean up a suspended process if assigning it to the job failed.
      if (created && process.Process != IntPtr.Zero) TerminateProcess(process.Process, 125);
      if (job != IntPtr.Zero) CloseHandle(job);
      if (process.Thread != IntPtr.Zero) CloseHandle(process.Thread);
      if (process.Process != IntPtr.Zero) CloseHandle(process.Process);
      foreach (var handle in new [] { input, output, error }) if (handle != IntPtr.Zero && handle != new IntPtr(-1)) CloseHandle(handle);
    }
  }
}
