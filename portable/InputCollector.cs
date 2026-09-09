using System;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class InputCollector
{
    private delegate IntPtr HookProc(int code, IntPtr message, IntPtr data);
    [StructLayout(LayoutKind.Sequential)] private struct Point { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] private struct MouseData { public Point Point; public uint MouseDataValue, Flags, Time; public IntPtr Extra; }
    [StructLayout(LayoutKind.Sequential)] private struct Message { public IntPtr Window; public uint Id; public IntPtr WParam, LParam; public uint Time; public Point Point; }
    [DllImport("user32.dll", SetLastError=true)] private static extern IntPtr SetWindowsHookEx(int id, HookProc callback, IntPtr module, uint thread);
    [DllImport("user32.dll")] private static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr message, IntPtr data);
    [DllImport("user32.dll")] private static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] private static extern int GetMessage(out Message message, IntPtr window, uint min, uint max);
    [DllImport("user32.dll")] private static extern bool TranslateMessage(ref Message message);
    [DllImport("user32.dll")] private static extern IntPtr DispatchMessage(ref Message message);

    private static readonly object OutputLock = new object();
    private static readonly Stopwatch Monotonic = Stopwatch.StartNew();
    private static HookProc KeyboardCallback, MouseCallback;
    private static double? PreviousKey;
    private static int LastX, LastY;
    private static bool HavePosition;
    private static long MovementX, MovementY;

    private static string Number(double value) { return value.ToString("0.###", CultureInfo.InvariantCulture); }
    private static double UtcMs() { return (DateTime.UtcNow - new DateTime(1970,1,1,0,0,0,DateTimeKind.Utc)).TotalMilliseconds; }
    private static void Emit(string type, string fields="")
    {
        lock(OutputLock) Console.WriteLine("{\"type\":\""+type+"\",\"timestamp_ms\":"+Number(UtcMs())+",\"monotonic_ms\":"+Number(Monotonic.Elapsed.TotalMilliseconds)+fields+"}");
    }
    private static IntPtr Keyboard(int code, IntPtr message, IntPtr data)
    {
        if(code>=0 && (message.ToInt64()==0x100 || message.ToInt64()==0x104)) { var now=Monotonic.Elapsed.TotalMilliseconds; var interval=PreviousKey.HasValue?Number(now-PreviousKey.Value):"null"; PreviousKey=now; Emit("keydown",",\"interval_ms\":"+interval); }
        return CallNextHookEx(IntPtr.Zero,code,message,data);
    }
    private static IntPtr Mouse(int code, IntPtr message, IntPtr data)
    {
        if(code>=0) { var value=(MouseData)Marshal.PtrToStructure(data,typeof(MouseData)); var id=message.ToInt64();
            if(id==0x201 || id==0x204 || id==0x207 || id==0x20B) Emit("click");
            else if(id==0x20A || id==0x20E) { var delta=(short)(value.MouseDataValue>>16); Emit("scroll",",\"scroll_x\":"+(id==0x20E?delta:0)+",\"scroll_y\":"+(id==0x20A?delta:0)); }
            else if(id==0x200) { if(HavePosition) { Interlocked.Add(ref MovementX,Math.Abs(value.Point.X-LastX)); Interlocked.Add(ref MovementY,Math.Abs(value.Point.Y-LastY)); } LastX=value.Point.X; LastY=value.Point.Y; HavePosition=true; }
        }
        return CallNextHookEx(IntPtr.Zero,code,message,data);
    }
    public static int Main()
    {
        Console.OutputEncoding=new UTF8Encoding(false); KeyboardCallback=Keyboard; MouseCallback=Mouse;
        var keyboard=SetWindowsHookEx(13,KeyboardCallback,IntPtr.Zero,0); var mouse=SetWindowsHookEx(14,MouseCallback,IntPtr.Zero,0);
        if(keyboard==IntPtr.Zero || mouse==IntPtr.Zero) return Marshal.GetLastWin32Error();
        Emit("heartbeat"); using(var timer=new Timer(_=>{var x=Interlocked.Exchange(ref MovementX,0);var y=Interlocked.Exchange(ref MovementY,0);Emit("movement",",\"delta_x\":"+x+",\"delta_y\":"+y);Emit("heartbeat");},null,1000,1000))
        { Message message; while(GetMessage(out message,IntPtr.Zero,0,0)>0) { TranslateMessage(ref message); DispatchMessage(ref message); } }
        UnhookWindowsHookEx(keyboard); UnhookWindowsHookEx(mouse); return 0;
    }
}
