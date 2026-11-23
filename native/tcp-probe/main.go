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
	"errors"
	"io"
	"net"
	"net/netip"
	"os"
	"syscall"
	"time"
)

const cookie uint32 = 0x2112a442

const observer = "stunserver2025.stunprotocol.org"

// IsGlobalUnicast also accepts private, shared, and documentation addresses.
var reserved = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"), netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("192.0.0.0/24"), netip.MustParsePrefix("192.0.2.0/24"),
	netip.MustParsePrefix("192.88.99.0/24"), netip.MustParsePrefix("198.18.0.0/15"),
	netip.MustParsePrefix("198.51.100.0/24"), netip.MustParsePrefix("203.0.113.0/24"),
	netip.MustParsePrefix("240.0.0.0/4"),
}

func publicIPv4(ip netip.Addr) bool {
	if !ip.Is4() || !ip.IsGlobalUnicast() || ip.IsPrivate() {
		return false
	}
	for _, prefix := range reserved {
		if prefix.Contains(ip) {
			return false
		}
	}
	return true
}

type event map[string]any

func emit(v event) { _ = json.NewEncoder(os.Stdout).Encode(v) }

func fail(stage, reason string) event {
	return event{"event": "result", "ok": false, "stage": stage, "reason": reason}
}

func reusable(_ string, _ string, raw syscall.RawConn) error {
	var sockErr error
	err := raw.Control(func(fd uintptr) { sockErr = reuseAddress(fd) })
	if err != nil {
		return err
	}
	return sockErr
}

func socketReason(err error) string {
	if errors.Is(err, context.DeadlineExceeded) {
		return "timeout"
	}
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return "timeout"
	}
	switch {
	case errors.Is(err, syscall.EADDRINUSE), errors.Is(err, syscall.Errno(10048)):
		return "address_in_use"
	case errors.Is(err, syscall.EACCES), errors.Is(err, syscall.Errno(10013)):
		return "permission_denied"
	case errors.Is(err, syscall.ECONNREFUSED), errors.Is(err, syscall.Errno(10061)):
		return "refused"
	case errors.Is(err, syscall.ENETUNREACH), errors.Is(err, syscall.EHOSTUNREACH), errors.Is(err, syscall.Errno(10051)), errors.Is(err, syscall.Errno(10065)):
		return "unreachable"
	case errors.Is(err, io.EOF), errors.Is(err, io.ErrUnexpectedEOF):
		return "closed"
	default:
		return "socket_error"
	}
}

func writeAll(w io.Writer, data []byte) error {
	for len(data) > 0 {
		n, err := w.Write(data)
		if err != nil {
			return err
		}
		if n == 0 {
			return io.ErrShortWrite
		}
		data = data[n:]
	}
	return nil
}

// Keep the Binding transaction on the exact IPv4 TCP socket that establishes the mapping.
func observe(c net.Conn) (netip.AddrPort, string) {
	_ = c.SetDeadline(time.Now().Add(6 * time.Second))
	defer c.SetDeadline(time.Time{})
	var req, resp [20]byte
	binary.BigEndian.PutUint16(req[:2], 1)
	binary.BigEndian.PutUint32(req[4:8], cookie)
	if _, err := rand.Read(req[8:]); err != nil {
		return netip.AddrPort{}, "random_failed"
	}
	if err := writeAll(c, req[:]); err != nil {
		return netip.AddrPort{}, socketReason(err)
	}
	if _, err := io.ReadFull(c, resp[:]); err != nil {
		return netip.AddrPort{}, socketReason(err)
	}
	if !bytes.Equal(req[4:], resp[4:]) {
		return netip.AddrPort{}, "transaction_mismatch"
	}
	if binary.BigEndian.Uint16(resp[:2]) != 0x0101 {
		return netip.AddrPort{}, "not_binding_success"
	}
	size := int(binary.BigEndian.Uint16(resp[2:4]))
	if size%4 != 0 || size > 4096 {
		return netip.AddrPort{}, "bad_length"
	}
	body := make([]byte, size)
	if _, err := io.ReadFull(c, body); err != nil {
		return netip.AddrPort{}, socketReason(err)
	}
	for len(body) >= 4 {
		typ := binary.BigEndian.Uint16(body[:2])
		n := int(binary.BigEndian.Uint16(body[2:4]))
		padded := (n + 3) &^ 3
		if padded > len(body)-4 {
			return netip.AddrPort{}, "bad_attribute"
		}
		value := body[4 : 4+n]
		if typ == 0x0020 && len(value) == 8 && value[1] == 1 {
			port := binary.BigEndian.Uint16(value[2:4]) ^ uint16(cookie>>16)
			var ip [4]byte
			binary.BigEndian.PutUint32(ip[:], binary.BigEndian.Uint32(value[4:])^cookie)
			mapped := netip.AddrPortFrom(netip.AddrFrom4(ip), port)
			if port < 1024 || !publicIPv4(mapped.Addr()) {
				return netip.AddrPort{}, "invalid_mapping"
			}
			return mapped, ""
		}
		body = body[4+padded:]
	}
	return netip.AddrPort{}, "no_xor_ipv4"
}

func proof(key []byte, label string, from, to []byte) []byte {
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte("momo-tcp-diagnostic-v1/" + label))
	mac.Write(from)
	mac.Write(to)
	return mac.Sum(nil)
}

func exchange(c net.Conn, out, in []byte) bool {
	if err := writeAll(c, out); err != nil {
		return false
	}
	_, err := io.ReadFull(c, in)
	return err == nil
}

// Prove both sides know the test-only secret and received the other's fresh challenge.
func authenticate(c net.Conn, key []byte) bool {
	_ = c.SetDeadline(time.Now().Add(2500 * time.Millisecond))
	var mine, theirs, reply [32]byte
	if _, err := rand.Read(mine[:]); err != nil {
		return false
	}
	if !exchange(c, mine[:], theirs[:]) || mine == theirs {
		return false
	}
	for _, label := range []string{"proof", "ack"} {
		if !exchange(c, proof(key, label, mine[:], theirs[:]), reply[:]) {
			return false
		}
		if !hmac.Equal(reply[:], proof(key, label, theirs[:], mine[:])) {
			return false
		}
	}
	return true
}

func tryPeer(local *net.TCPAddr, remote netip.AddrPort, key []byte) event {
	const window = 22 * time.Second
	ctx, cancel := context.WithTimeout(context.Background(), window)
	defer cancel()
	win := make(chan string, 1)
	dialStat := make(chan string, 1)
	authFailed := make(chan struct{}, 1)
	check := func(c net.Conn, path string) {
		defer c.Close()
		if !authenticate(c, key) {
			select {
			case authFailed <- struct{}{}:
			default:
			}
			return
		}
		select {
		case win <- path:
		default:
		}
	}
	lc := net.ListenConfig{Control: reusable}
	listener, lerr := lc.Listen(ctx, "tcp4", local.String())
	listenStatus := "listening"
	if lerr != nil {
		listenStatus = socketReason(lerr)
	} else {
		defer listener.Close()
		// Some OS socket stacks allow the listener but refuse an outgoing bind while
		// it exists. Leave the STUN socket open and try active-only for the second half.
		stopListening := time.AfterFunc(window/2, func() { _ = listener.Close() })
		defer stopListening.Stop()
		go func() {
			slots := make(chan struct{}, 4)
			for {
				conn, err := listener.Accept()
				if err != nil {
					return
				}
				client := conn.RemoteAddr().(*net.TCPAddr).AddrPort().Addr().Unmap()
				if client != remote.Addr() {
					conn.Close()
					continue
				}
				select {
				case slots <- struct{}{}:
					go func(c net.Conn) { defer func() { <-slots }(); check(c, "accept") }(conn)
				default:
					conn.Close()
				}
			}
		}()
	}
	go func() {
		d := net.Dialer{LocalAddr: local, Control: reusable, Timeout: 3 * time.Second}
		for ctx.Err() == nil {
			c, err := d.DialContext(ctx, "tcp4", remote.String())
			status := "connected"
			if err == nil {
				check(c, "dial")
			} else {
				status = socketReason(err)
			}
			select {
			case <-dialStat:
			default:
			}
			dialStat <- status
			select {
			case <-ctx.Done():
				return
			case <-time.After(380 * time.Millisecond):
			}
		}
	}()
	select {
	case path := <-win:
		return event{"event": "result", "ok": true, "path": path, "listen": listenStatus}
	case <-ctx.Done():
		result := fail("peer", "no_authenticated_peer")
		result["listen"] = listenStatus
		select {
		case result["dial"] = <-dialStat:
		default:
			result["dial"] = "pending"
		}
		select {
		case <-authFailed:
			result["reason"] = "peer_handshake_failed"
		default:
		}
		return result
	}
}

type command struct {
	Endpoint string
	Token    string
}

func run() event {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	addresses, err := net.DefaultResolver.LookupNetIP(ctx, "ip4", observer)
	if err != nil || len(addresses) == 0 {
		return fail("stun", "dns_failure")
	}
	serverIP := addresses[0].Unmap()
	if !publicIPv4(serverIP) {
		return fail("stun", "invalid_observer_address")
	}
	server := netip.AddrPortFrom(serverIP, 3478).String()
	// This UDP connect only asks the local kernel which interface would carry the route.
	route, err := (&net.Dialer{}).DialContext(ctx, "udp4", server)
	if err != nil {
		return fail("local_route", socketReason(err))
	}
	ip := route.LocalAddr().(*net.UDPAddr).IP
	route.Close()
	d := net.Dialer{LocalAddr: &net.TCPAddr{IP: ip}, Control: reusable}
	c, err := d.DialContext(ctx, "tcp4", server)
	if err != nil {
		return fail("stun_connect", socketReason(err))
	}
	defer c.Close()
	mapped, why := observe(c)
	if why != "" {
		return fail("stun_binding", why)
	}
	emit(event{"event": "mapped", "endpoint": mapped.String()})
	reader := bufio.NewScanner(os.Stdin)
	reader.Buffer(make([]byte, 512), 1024)
	if !reader.Scan() {
		return fail("coordination", "no_command")
	}
	var cmd command
	if err := json.Unmarshal(reader.Bytes(), &cmd); err != nil {
		return fail("coordination", "invalid_json")
	}
	target, err := netip.ParseAddrPort(cmd.Endpoint)
	if err != nil || !publicIPv4(target.Addr()) || target.Port() < 1024 || target == mapped {
		return fail("coordination", "invalid_peer")
	}
	key, err := hex.DecodeString(cmd.Token)
	if err != nil || len(key) != 32 {
		return fail("coordination", "invalid_token")
	}
	return tryPeer(c.LocalAddr().(*net.TCPAddr), target, key)
}

func main() {
	start := run
	if len(os.Args) == 2 && os.Args[1] == "--udp" {
		start = runUDP
	} else if len(os.Args) != 1 {
		emit(fail("coordination", "unexpected_arguments"))
		return
	}
	done := make(chan event, 1)
	go func() { done <- start() }()
	select {
	case result := <-done:
		emit(result)
	case <-time.After(110 * time.Second):
		emit(fail("deadline", "hard_timeout"))
	}
}
