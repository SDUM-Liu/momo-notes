package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"net"
	"net/netip"
	"os"
	"time"
)

func udpMapping(socket *net.UDPConn, observer netip.AddrPort) (netip.AddrPort, bool) {
	var request [20]byte
	binary.BigEndian.PutUint16(request[:2], 1)
	binary.BigEndian.PutUint32(request[4:8], cookie)
	if _, err := rand.Read(request[8:]); err != nil {
		return netip.AddrPort{}, false
	}
	var response [1024]byte
	for round := 0; round < 3; round++ {
		socket.WriteToUDPAddrPort(request[:], observer)
		socket.SetReadDeadline(time.Now().Add(550 * time.Millisecond))
		for {
			n, sender, err := socket.ReadFromUDPAddrPort(response[:])
			if err != nil {
				break
			}
			if sender != observer || n < 20 || binary.BigEndian.Uint16(response[:2]) != 0x0101 ||
				!bytes.Equal(response[4:20], request[4:20]) {
				continue
			}
			length := int(binary.BigEndian.Uint16(response[2:4]))
			if length%4 != 0 || length != n-20 {
				continue
			}
			for i := 20; i+4 <= n; {
				size := int(binary.BigEndian.Uint16(response[i+2 : i+4]))
				next := i + 4 + ((size + 3) &^ 3)
				if next > n {
					break
				}
				if size == 8 && binary.BigEndian.Uint16(response[i:i+2]) == 0x20 && response[i+5] == 1 {
					port := binary.BigEndian.Uint16(response[i+6:i+8]) ^ uint16(cookie>>16)
					var raw [4]byte
					binary.BigEndian.PutUint32(raw[:], binary.BigEndian.Uint32(response[i+8:i+12])^cookie)
					ip := netip.AddrFrom4(raw)
					if publicIPv4(ip) && port >= 1024 {
						return netip.AddrPortFrom(ip, port), true
					}
				}
				i = next
			}
		}
	}
	return netip.AddrPort{}, false
}

func udpTag(key, body []byte) []byte {
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte("momo-udp-diagnostic-v1/"))
	mac.Write(body)
	return mac.Sum(nil)
}

func punchUDP(socket *net.UDPConn, peers []netip.AddrPort, key []byte, timeout time.Duration) bool {
	var outgoing [64]byte
	var incoming [65]byte
	if _, err := rand.Read(outgoing[:16]); err != nil {
		return false
	}
	var learned netip.AddrPort
	var firstVerified time.Time
	until := time.Now().Add(timeout)
	for time.Now().Before(until) {
		copy(outgoing[32:], udpTag(key, outgoing[:32]))
		for _, peer := range peers {
			socket.WriteToUDPAddrPort(outgoing[:], peer)
		}
		if learned.IsValid() {
			known := false
			for _, peer := range peers {
				known = known || peer == learned
			}
			if !known {
				socket.WriteToUDPAddrPort(outgoing[:], learned)
			}
		}
		socket.SetReadDeadline(time.Now().Add(170 * time.Millisecond))
		for {
			n, sender, err := socket.ReadFromUDPAddrPort(incoming[:])
			if err != nil {
				break
			}
			known := false
			for _, peer := range peers {
				known = known || peer.Addr() == sender.Addr()
			}
			if !known || n != 64 || sender.Port() < 1024 ||
				bytes.Equal(incoming[:16], outgoing[:16]) || !hmac.Equal(incoming[32:64], udpTag(key, incoming[:32])) {
				continue
			}
			learned = sender
			copy(outgoing[16:32], incoming[:16])
			if firstVerified.IsZero() && bytes.Equal(incoming[16:32], outgoing[:16]) {
				firstVerified = time.Now()
			}
		}
		if !firstVerified.IsZero() && time.Since(firstVerified) >= time.Second {
			return true
		}
	}
	return false
}

func runUDP() event {
	socket, err := net.ListenUDP("udp4", nil)
	if err != nil {
		return fail("stun", "observer_unavailable")
	}
	defer socket.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	mapped := map[netip.AddrPort]bool{}
	endpoints := []string{}
	for _, server := range []struct {
		host string
		port uint16
	}{{"stun.cloudflare.com", 3478}, {"stun.l.google.com", 19302}} {
		lookup, stop := context.WithTimeout(ctx, 3*time.Second)
		ips, err := net.DefaultResolver.LookupNetIP(lookup, "ip4", server.host)
		stop()
		if err != nil || len(ips) == 0 || !publicIPv4(ips[0]) {
			continue
		}
		result, ok := udpMapping(socket, netip.AddrPortFrom(ips[0], server.port))
		if ok && !mapped[result] {
			mapped[result] = true
			endpoints = append(endpoints, result.String())
		}
	}
	if len(endpoints) == 0 {
		return fail("stun", "observer_unavailable")
	}
	emit(event{"event": "mapped", "endpoints": endpoints})
	input := bufio.NewScanner(os.Stdin)
	input.Buffer(make([]byte, 512), 1024)
	if !input.Scan() {
		return fail("coordination", "no_command")
	}
	var cmd struct {
		Endpoints []string
		Token     string
	}
	if json.Unmarshal(input.Bytes(), &cmd) != nil || len(cmd.Endpoints) < 1 || len(cmd.Endpoints) > 2 {
		return fail("coordination", "invalid_peer")
	}
	peers := []netip.AddrPort{}
	for _, raw := range cmd.Endpoints {
		peer, err := netip.ParseAddrPort(raw)
		if err != nil || !publicIPv4(peer.Addr()) || peer.Port() < 1024 {
			return fail("coordination", "invalid_peer")
		}
		if !mapped[peer] {
			peers = append(peers, peer)
		}
	}
	if len(peers) == 0 {
		return fail("coordination", "invalid_peer")
	}
	key, err := hex.DecodeString(cmd.Token)
	if err != nil || len(key) != 32 {
		return fail("coordination", "invalid_token")
	}
	if punchUDP(socket, peers, key, 18*time.Second) {
		return event{"event": "result", "ok": true}
	}
	return fail("udp", "no_authenticated_peer")
}
