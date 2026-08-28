package tui

import (
	"strings"

	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/voocel/ainovel-cli/internal/i18n"
)

type helpState struct {
	viewport viewport.Model
}

func newHelpState(width, height int) *helpState {
	boxW, boxH := reportModalSize(width, height)
	contentW := paddedModalContentWidth(boxW)
	text := renderHelpText(contentW)

	vp := viewport.New(contentW, boxH-4)
	vp.SetContent(text)
	return &helpState{viewport: vp}
}

func renderHelpText(width int) string {
	titleStyle := lipgloss.NewStyle().Foreground(colorAccent).Bold(true)
	nameStyle := lipgloss.NewStyle().Foreground(colorAccent2).Bold(true)
	usageStyle := lipgloss.NewStyle().Foreground(colorMuted)
	descStyle := lipgloss.NewStyle().Foreground(bodyTextColor)
	hintStyle := lipgloss.NewStyle().Foreground(colorDim)

	var b strings.Builder
	b.WriteString(titleStyle.Render(i18n.T("tui.modals.help_title")))
	b.WriteString("\n\n")

	for i, spec := range commandSpecs() {
		if i > 0 {
			b.WriteString("\n")
		}
		b.WriteString(nameStyle.Render("/" + spec.Name))
		if len(spec.Aliases) > 0 {
			b.WriteString(usageStyle.Render("  alias: /" + strings.Join(spec.Aliases, " /")))
		}
		b.WriteString("\n")
		b.WriteString(usageStyle.Render("Usage: " + spec.Usage))
		b.WriteString("\n")
		b.WriteString(descStyle.Render(wrapText(spec.LocalizedDescription(), width)))
		b.WriteString("\n")
	}

	b.WriteString("\n")
	b.WriteString(titleStyle.Render(i18n.T("tui.help.shortcuts_title")))
	b.WriteString("\n\n")
	for _, key := range []string{
		"tui.help.shortcut_search",
		"tui.help.shortcut_navigate",
		"tui.help.shortcut_accept",
		"tui.help.shortcut_close",
		"tui.help.shortcut_copy",
	} {
		b.WriteString(hintStyle.Render(i18n.T(key)))
		b.WriteString("\n")
	}
	return b.String()
}

func renderHelpModal(width, height int, state *helpState) string {
	if state == nil {
		return ""
	}

	boxW, boxH := reportModalSize(width, height)
	contentW := paddedModalContentWidth(boxW)

	if state.viewport.Width != contentW {
		state.viewport.Width = contentW
	}
	if state.viewport.Height != boxH-4 {
		state.viewport.Height = boxH - 4
	}

	modal := renderPaddedModalFrame(
		boxW,
		boxH,
		i18n.T("tui.modals.help_title"),
		"  ↑↓ "+i18n.T("tui.modals.select")+" · Esc "+i18n.T("tui.modals.close"),
		strings.Split(state.viewport.View(), "\n"),
	)
	return lipgloss.Place(width, height, lipgloss.Center, lipgloss.Center, modal)
}

func (m Model) handleHelpKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if m.help == nil {
		return m, nil
	}
	switch msg.Type {
	case tea.KeyEsc:
		m.help = nil
		return m, m.textarea.Focus()
	case tea.KeyUp:
		m.help.viewport.ScrollUp(1)
		return m, nil
	case tea.KeyDown:
		m.help.viewport.ScrollDown(1)
		return m, nil
	case tea.KeyPgUp:
		m.help.viewport.HalfPageUp()
		return m, nil
	case tea.KeyPgDown:
		m.help.viewport.HalfPageDown()
		return m, nil
	default:
		return m, nil
	}
}
