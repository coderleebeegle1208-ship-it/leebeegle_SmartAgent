' Starts the Agent Remote server without a console window. Used by the logon scheduled task.
Set sh = CreateObject("WScript.Shell")
root = Replace(WScript.ScriptFullName, "\scripts\start-hidden.vbs", "")
sh.CurrentDirectory = root
sh.Run "cmd /c node --no-warnings=ExperimentalWarning server\index.js >> data\server.log 2>&1", 0, False
