package main

import (
	"net"
	"net/netip"
	"testing"
	"time"
)

func TestUDPPredictionRequiresConsistentSamples(t *testing.T) {
	samples := func(values ...string) []netip.AddrPort {
		result := []netip.AddrPort{}
		for _, value := range values {
			result = append(result, netip.MustParseAddrPort(value))
		}
		return result
	}
	got := predictUDPPorts(samples("1.1.1.1:50000", "1.1.1.1:50002", "1.1.1.1:50004"))
	want := samples("1.1.1.1:50006", "1.1.1.1:50008", "1.1.1.1:50010", "1.1.1.1:50012")
	for i, item := range want {
		if len(got) != len(want) || item != got[i] {
			t.Fatalf("unexpected predictions: %v", got)
		}
	}
	for _, items := range [][]netip.AddrPort{
		samples("1.1.1.1:50000", "1.1.1.1:50002"),
		samples("1.1.1.1:50000", "1.1.1.1:50001", "1.1.1.1:50006"),
		samples("1.1.1.1:50000", "1.1.1.1:50000", "1.1.1.1:50000"),
		samples("1.1.1.1:50000", "8.8.8.8:50002", "1.1.1.1:50004"),
	} {
		if got := predictUDPPorts(items); len(got) > 0 {
			t.Fatalf("ambiguous samples must not predict: %v", got)
		}
	}
}

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
