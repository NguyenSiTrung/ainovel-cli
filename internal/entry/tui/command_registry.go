package tui

import (
	"strings"

	"github.com/voocel/ainovel-cli/internal/i18n"
)

type commandRegistry struct {
	specs []slashCommandSpec
}

func newCommandRegistry(specs []slashCommandSpec) commandRegistry {
	return commandRegistry{specs: append([]slashCommandSpec(nil), specs...)}
}

func (r commandRegistry) Visible() []slashCommandSpec {
	var out []slashCommandSpec
	for _, spec := range r.specs {
		if !spec.Hidden {
			out = append(out, spec)
		}
	}
	return out
}

func (r commandRegistry) Find(name string) (slashCommandSpec, bool) {
	name = strings.ToLower(strings.TrimSpace(name))
	if name == "" {
		return slashCommandSpec{}, false
	}
	for _, spec := range r.specs {
		if spec.matches(name) {
			return spec, true
		}
	}
	return slashCommandSpec{}, false
}

func (s slashCommandSpec) LocalizedDescription() string {
	key := "tui.cmd." + s.Name + ".desc"
	if i18n.Has(key) {
		return i18n.T(key)
	}
	key2 := "tui.commands." + s.Name + ".desc"
	if i18n.Has(key2) {
		return i18n.T(key2)
	}
	return s.Description
}

func (r commandRegistry) PaletteItems() []commandPaletteItem {
	var items []commandPaletteItem
	for _, spec := range r.Visible() {
		items = append(items, commandPaletteItem{
			Name:        spec.Name,
			Aliases:     append([]string(nil), spec.Aliases...),
			Usage:       spec.Usage,
			Description: spec.LocalizedDescription(),
			AutoExecute: spec.AutoExecute,
		})
	}
	return items
}
