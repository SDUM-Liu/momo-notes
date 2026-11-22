//go:build (linux || android) && (arm64 || amd64 || arm || 386)

package main

import "syscall"

func reuseAddress(fd uintptr) error {
	if err := syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET, syscall.SO_REUSEADDR, 1); err != nil {
		return err
	}
	// Android/Linux on these architectures assigns SO_REUSEPORT option number 15.
	// All three sockets opt in so the listener can coexist with the active peer dial.
	const soReusePort = 15
	return syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET, soReusePort, 1)
}
