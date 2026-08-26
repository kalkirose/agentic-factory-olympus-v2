# Service wiring

The daemon runs in the foreground; the OS service manager owns
daemonization, at-boot start, and restart-on-failure. `olympusd stop` always
requests a clean stop through the control inbox, so the daemon stamps
`daemon-stopped` before exit.

## systemd (Linux)

`/etc/systemd/system/olympusd.service`:

```ini
[Unit]
Description=Olympus v2 orchestrator daemon
After=network-online.target docker.service

[Service]
ExecStart=/usr/bin/node /opt/olympus-v2/bin/olympusd.mjs start --home /var/lib/olympusd
Restart=on-failure
RestartSec=5
User=olympus

[Install]
WantedBy=multi-user.target
```

Enable with `systemctl enable --now olympusd`.

## Windows

Use a service wrapper (for example WinSW or NSSM) so the process restarts on
failure and starts at boot. Example WinSW config:

```xml
<service>
  <id>olympusd</id>
  <name>Olympus v2 daemon</name>
  <executable>node</executable>
  <arguments>C:\olympus-v2\bin\olympusd.mjs start --home C:\olympusd-home</arguments>
  <onfailure action="restart" delay="5 sec"/>
  <startmode>Automatic</startmode>
</service>
```

Task Scheduler ("At startup", restart on failure) also works when a service
wrapper is not wanted.

## Notes

- One daemon per home. The lock file refuses a second instance; a stale lock
  from a crash clears itself.
- Restart is safe at any point: the daemon resumes every open run from its
  ledger stamps.
- Stop for maintenance with `olympusd stop`; the service manager must not
  auto-restart after a clean stop (systemd: clean exit + `Restart=on-failure`
  covers this).
- A stop mid-stage ends the seats it finds and the run re-enters that stage at
  the next start, so the work those children had done is spent again. The
  cheap restart takes the hold first: `olympusctl hold --all`, wait until
  `olympusctl status` shows every run held or parked, `olympusd stop`, start,
  then `olympusctl release --all`. The hold is in the instance ledger, so it is
  still standing when the new instance comes up (ADR-0040).
