#!/bin/bash
# A throwaway local validator for the armed-pause demo (services/monitor/scripts/local-pause-demo.ts). Ports are not the defaults,
# so it cannot collide with another validator on this machine.
BIN=$HOME/.local/share/solana/install/active_release/bin
pkill -f 'rpc-port 18899' 2>/dev/null
rm -rf /tmp/oc-q3
nohup $BIN/solana-test-validator --ledger /tmp/oc-q3 --reset --quiet --rpc-port 18899 --faucet-port 18903 --gossip-port 18904 --bind-address 127.0.0.1 > /tmp/oc-q3.log 2>&1 &
sleep 2
$BIN/solana-test-validator --version
echo started
