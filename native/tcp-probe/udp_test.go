package main

import (
	"net"
	"net/netip"
	"testing"
	"time"
)

func TestUDPPeersProveBothDirections(t *testing.T) {
	first, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	second, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer second.Close()
	peer := func(socket *net.UDPConn) []netip.AddrPort {
		return []netip.AddrPort{socket.LocalAddr().(*net.UDPAddr).AddrPort()}
	}
	key := make([]byte, 32)
	a, b := make(chan bool, 1), make(chan bool, 1)
	go func() { a <- punchUDP(first, peer(second), key, 3*time.Second) }()
	go func() { b <- punchUDP(second, peer(first), key, 3*time.Second) }()
	if !<-a || !<-b {
		t.Fatal("both peers must authenticate their direct UDP exchange")
	}
	wrong := make([]byte, 32)
	wrong[0] = 1
	go func() { a <- punchUDP(first, peer(second), key, 400*time.Millisecond) }()
	go func() { b <- punchUDP(second, peer(first), wrong, 400*time.Millisecond) }()
	if <-a || <-b {
		t.Fatal("different keys must not verify")
	}
}
