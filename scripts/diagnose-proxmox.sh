#!/usr/bin/env bash
set -u
# Read-only; run on the Proxmox host.
pct config 119
pct config 120
pct exec 119 -- ip -br -4 address
pct exec 119 -- ip route get 10.0.0.58
pct exec 119 -- ip route get 10.0.0.162
pct exec 119 -- node -e '
const net=require("node:net");
for(const port of [25565,3001,25576]){
 const s=net.connect({host:"10.0.0.58",port});
 s.setTimeout(3000,()=>{console.log(port,"TIMEOUT");s.destroy()});
 s.on("connect",()=>{console.log(port,"OPEN");s.end()});
 s.on("error",e=>console.log(port,e.code));
}'
pct exec 119 -- curl --connect-timeout 4 --max-time 8 -sS http://10.0.0.162:1234/v1/models
pct exec 120 -- docker ps --format '{{.Names}} {{.Ports}}'
pct exec 120 -- sysctl net.ipv4.ip_forward
pct exec 120 -- iptables -t nat -S
pct exec 120 -- iptables -S FORWARD
journalctl -k --since '-10 minutes' --grep='apparmor="DENIED"' --no-pager -n 30
