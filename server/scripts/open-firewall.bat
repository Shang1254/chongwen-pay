@echo off
rem ============================================================
rem  Open Windows Firewall for the backend port (TCP 3000)
rem  Double-click me. A UAC popup will appear - click "Yes".
rem ============================================================
echo Adding firewall rule: allow inbound TCP 3000 ...
netsh advfirewall firewall add rule name="CWLT-Pay-3000" dir=in action=allow protocol=TCP localport=3000 >nul 2>nul
if errorlevel 1 (
  echo Need admin rights - asking via UAC popup...
  powershell -Command "Start-Process netsh -ArgumentList 'advfirewall firewall add rule name=CWLT-Pay-3000 dir=in action=allow protocol=TCP localport=3000' -Verb RunAs" >nul 2>nul
)
echo Done. Now LAN devices (your phone) can reach port 3000.
pause
