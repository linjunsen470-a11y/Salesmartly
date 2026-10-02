using System;
using System.IO;
using System.Diagnostics;
using System.Threading;
using System.Collections.Generic;
using System.Web.Script.Serialization;

// Chrome starts this executable with pipes. Never write logs to stdout.
class NativeLauncher {
    static void Relay(Stream input, Stream output) {
        byte[] buffer = new byte[16384]; int count;
        while ((count = input.Read(buffer, 0, buffer.Length)) > 0) {
            output.Write(buffer, 0, count); output.Flush();
        }
    }
    static string Quote(string value) {
        if (value.Length > 0 && value.IndexOfAny(new char[]{' ', '\t', '\n', '\v', '"'}) < 0) return value;
        System.Text.StringBuilder result = new System.Text.StringBuilder("\"");
        int slash = 0;
        foreach (char c in value) {
            if (c == '\\') { slash++; continue; }
            if (c == '"') { result.Append('\\', slash * 2 + 1); result.Append(c); slash = 0; continue; }
            result.Append('\\', slash); slash = 0; result.Append(c);
        }
        result.Append('\\', slash * 2); return result.Append('"').ToString();
    }
    static int Main(string[] args) {
        try {
            string directory = AppDomain.CurrentDomain.BaseDirectory;
            var config = new JavaScriptSerializer().Deserialize<Dictionary<string, string>>(File.ReadAllText(Path.Combine(directory, "launcher.json")));
            string arguments = "--disable-warning=ExperimentalWarning " + Quote(config["nativeEntry"]) + " --config " + Quote(config["configPath"]);
            foreach (string arg in args) arguments += " " + Quote(arg);
            var info = new ProcessStartInfo(config["nodePath"], arguments);
            info.UseShellExecute = false; info.CreateNoWindow = true;
            info.RedirectStandardInput = true; info.RedirectStandardOutput = true; info.RedirectStandardError = true;
            info.WorkingDirectory = directory;
            using (Process child = Process.Start(info)) {
                var input = new Thread(delegate() { try { Relay(Console.OpenStandardInput(), child.StandardInput.BaseStream); child.StandardInput.Close(); } catch {} });
                var output = new Thread(delegate() { try { Relay(child.StandardOutput.BaseStream, Console.OpenStandardOutput()); } catch {} });
                var error = new Thread(delegate() { try { Relay(child.StandardError.BaseStream, Console.OpenStandardError()); } catch {} });
                input.IsBackground = true; output.IsBackground = true; error.IsBackground = true;
                input.Start(); output.Start(); error.Start(); child.WaitForExit(); output.Join(); error.Join();
                return child.ExitCode;
            }
        } catch (Exception error) { Console.Error.WriteLine("SaleSmartly launcher: " + error.Message); return 1; }
    }
}
