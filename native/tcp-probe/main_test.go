package main

import (
	"bytes"
	"encoding/binary"
	"encoding/hex"
	"io"
	"net"
	"net/netip"
	"testing"
	"time"
)

func TestPublicIPv4(t *testing.T) {
	for _, s := range []string{"0.0.0.1", "10.1.2.3", "100.64.0.1", "127.0.0.1", "169.254.0.1", "172.31.0.1", "192.0.0.9", "192.0.2.1", "192.88.99.1", "192.168.0.1", "198.19.0.9", "198.51.100.2", "203.0.113.1", "224.1.2.3", "241.2.3.4", "255.255.255.255", "::ffff:8.8.8.8", "2001:db8::1"} {
		if publicIPv4(netip.MustParseAddr(s)) {
			t.Errorf("accepted reserved address %s", s)
		}
	}
	if !publicIPv4(netip.MustParseAddr("8.8.8.8")) {
		t.Fatal("rejected public IPv4")
	}
}

func TestBinding(t *testing.T) {
	for _, tc := range []struct{ name, why string }{
		{"valid", ""}, {"wrong-id", "transaction_mismatch"}, {"wrong-type", "not_binding_success"},
		{"bad-length", "bad_attribute"}, {"private", "invalid_mapping"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, server := net.Pipe()
			defer c.Close()
			go func() {
				defer server.Close()
				packet := make([]byte, 32)
				if _, err := io.ReadFull(server, packet[:20]); err != nil {
					return
				}
				binary.BigEndian.PutUint16(packet[:2], 0x0101)
				binary.BigEndian.PutUint16(packet[2:4], 12)
				binary.BigEndian.PutUint16(packet[20:22], 0x0020)
				binary.BigEndian.PutUint16(packet[22:24], 8)
				packet[25] = 1
				binary.BigEndian.PutUint16(packet[26:28], 45678^uint16(cookie>>16))
				addr := uint32(0x08080808)
				switch tc.name {
				case "wrong-id":
					packet[15] ^= 0xff
				case "wrong-type":
					packet[0] = 0xff
				case "bad-length":
					packet[23] = 12
				case "private":
					addr = 0x0a000001
				}
				binary.BigEndian.PutUint32(packet[28:], addr^cookie)
				_ = writeAll(server, packet)
			}()
			endpoint, why := observe(c)
			if why != tc.why {
				t.Fatalf("expected %q, got %q", tc.why, why)
			}
			if tc.why == "" && endpoint.String() != "8.8.8.8:45678" {
				t.Fatalf("wrong mapping %v", endpoint)
			}
		})
	}
}

func TestNonceHandshakeOverTCP(t *testing.T) {
	for _, tc := range []struct {
		name    string
		peerKey byte
		success bool
	}{
		{"same secret", 1, true}, {"different secret", 2, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			l, err := net.Listen("tcp4", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			defer l.Close()
			out := make(chan bool, 1)
			go func() {
				c, err := l.Accept()
				if err != nil {
					out <- false
					return
				}
				defer c.Close()
				out <- authenticate(c, bytes.Repeat([]byte{tc.peerKey}, 32))
			}()
			c, err := net.DialTimeout("tcp4", l.Addr().String(), time.Second)
			if err != nil {
				t.Fatal(err)
			}
			defer c.Close()
			result := authenticate(c, bytes.Repeat([]byte{1}, 32))
			if peer := <-out; result != tc.success || peer != tc.success {
				t.Fatalf("client %v, peer %v, expected %v", result, peer, tc.success)
			}
		})
	}
}

func TestPeerProofWireFormat(t *testing.T) {
	key, from, to := bytes.Repeat([]byte{1}, 32), bytes.Repeat([]byte{2}, 32), bytes.Repeat([]byte{3}, 32)
	for label, expected := range map[string]string{
		"proof": "631aa9e80ac745a0c359ca78dbf5779bd50b1896b3e377d5db61aadef4a6d289",
		"ack":   "c143b76828cf2457acc090c0aad7d1b82a86124ff69890941dbf09ebbded3922",
	} {
		if hex.EncodeToString(proof(key, label, from, to)) != expected {
			t.Fatalf("incorrect %s wire format", label)
		}
	}
}
