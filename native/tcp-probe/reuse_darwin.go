package main

import "syscall"

func reuseAddress(fd uintptr) error {
	for _, option := range []int{syscall.SO_REUSEADDR, syscall.SO_REUSEPORT} {
		if err := syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET, option, 1); err != nil {
			return err
		}
	}
	return nil
}
