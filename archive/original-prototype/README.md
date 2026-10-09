# Project-SID Minecraft Autonomous Agent System

## LXC 119 Fixes

/etc/pve/lxc/119.conf
```
arch: amd64
cores: 2
hostname: sid-agent
memory: 2048
net0: name=eth0,bridge=vmbr0,firewall=1,hwaddr=02:00:00:11:9:01,ip=10.0.0.119/24,gw=10.0.0.1
onboot: 1
ostype: ubuntu
rootfs: local-lvm:vm-119-disk-0,size=8G
swap: 512
unprivileged: 1
```

Test connectivity:
`apt update && ping -c 1 10.0.0.58`

## Pterodactyl Networking Fixes

Ensure PaperMC binds 0.0.0.0:25565
server.properties:
```
server-ip=
server-port=25565
enable-query=true
```

Pterodactyl firewall allow 10.0.0.0/24 → 25565 TCP
LXC 119 can reach 10.0.0.58:25565

## Node.js Connection Code

agent-core/paperBridge.js
...
