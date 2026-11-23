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
	"slices"
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
	predictions := predictUDPPorts(peers)
	unique := []netip.AddrPort{}
	for _, peer := range peers {
		if !slices.Contains(unique, peer) {
			unique = append(unique, peer)
		}
	}
	peers = unique
	round := 0
	for time.Now().Before(until) {
		copy(outgoing[32:], udpTag(key, outgoing[:32]))
		for _, peer := range peers {
			socket.WriteToUDPAddrPort(outgoing[:], peer)
		}
		if !learned.IsValid() && len(predictions) > 0 {
			socket.WriteToUDPAddrPort(outgoing[:], predictions[round%len(predictions)])
			round++
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

// Observations must agree on the public IP and two consecutive port steps.
func predictUDPPorts(peers []netip.AddrPort) []netip.AddrPort {
	if len(peers) < 3 {
		return nil
	}
	last := len(peers) - 1
	a, b, c := peers[last-2], peers[last-1], peers[last]
	step := int(c.Port()) - int(b.Port())
	if a.Addr() != c.Addr() || b.Addr() != c.Addr() ||
		step == 0 || step < -16 || step > 16 || step != int(b.Port())-int(a.Port()) {
		return nil
	}
	var result []netip.AddrPort
	for n := 1; n <= 4; n++ {
		port := int(c.Port()) + n*step
		if port < 1024 || port > 65535 {
			break
		}
		result = append(result, netip.AddrPortFrom(c.Addr(), uint16(port)))
	}
	return result
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
	observers := map[netip.Addr]bool{}
	endpoints := []string{}
	for _, server := range []struct {
		host string
		port uint16
	}{{"stun.cloudflare.com", 3478}, {"stunserver2025.stunprotocol.org", 3478}, {"stun.l.google.com", 19302}, {"stun1.l.google.com", 19302}} {
		lookup, stop := context.WithTimeout(ctx, 1500*time.Millisecond)
		ips, err := net.DefaultResolver.LookupNetIP(lookup, "ip4", server.host)
		stop()
		if err != nil {
			continue
		}
		for _, ip := range ips {
			if !publicIPv4(ip) || observers[ip] {
				continue
			}
			observers[ip] = true
			result, ok := udpMapping(socket, netip.AddrPortFrom(ip, server.port))
			if ok {
				mapped[result] = true
				endpoints = append(endpoints, result.String())
			}
			break
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
	if json.Unmarshal(input.Bytes(), &cmd) != nil || len(cmd.Endpoints) < 1 || len(cmd.Endpoints) > 4 {
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
