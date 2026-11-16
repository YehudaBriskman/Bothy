#cloud-config
# Lab VM seed: a user and an ssh key, nothing else. No password login, no secrets.
hostname: @@HOSTNAME@@
disable_root: true
ssh_pwauth: false
package_update: false
users:
  - name: lab
    shell: /bin/bash
    sudo: ALL=(ALL) NOPASSWD:ALL
    lock_passwd: true
    ssh_authorized_keys:
      - "@@PUBKEY@@"
# Every boot: refuse NEW connections from the guest to the QEMU host address (10.0.2.2 = host loopback).
# Established ones stay allowed so the hostfwd ssh/portal replies work. DNS (10.0.2.3) is untouched.
# Defence in depth only: guest root can remove it. See lab/README.md, spike S15.
bootcmd:
  - [ sh, -c, "iptables -C OUTPUT -d 10.0.2.2 -m conntrack --ctstate NEW -j DROP 2>/dev/null || iptables -I OUTPUT 1 -d 10.0.2.2 -m conntrack --ctstate NEW -j DROP" ]
