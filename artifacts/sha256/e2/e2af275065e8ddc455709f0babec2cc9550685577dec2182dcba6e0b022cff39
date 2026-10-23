package tui

import (
	"strings"
	"sync"
)

// noticeBuffer collects internal/client's one-line notices (auto-start,
// version mismatch, directory warnings) instead of writing them to stderr,
// which would corrupt the alt-screen bubbletea owns. take() drains it; the
// model shows the drained lines as dim text under the active screen instead
// of discarding them.
type noticeBuffer struct {
	mu    sync.Mutex
	lines []string
}

func (b *noticeBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for _, line := range strings.Split(strings.TrimRight(string(p), "\n"), "\n") {
		if line != "" {
			b.lines = append(b.lines, line)
		}
	}
	return len(p), nil
}

func (b *noticeBuffer) take() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	lines := b.lines
	b.lines = nil
	return lines
}
