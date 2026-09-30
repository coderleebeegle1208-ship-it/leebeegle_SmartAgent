' Runs scripts\ensure-running.ps1 without flashing a console window. Used by the scheduled task.
Set sh = CreateObject("WScript.Shell")
root = Replace(WScript.ScriptFullName, "\scripts\ensure-running.vbs", "")
sh.CurrentDirectory = root
sh.Run "powershell -NoProfile -ExecutionPolicy Bypass -File """ & root & "\scripts\ensure-running.ps1""", 0, False
