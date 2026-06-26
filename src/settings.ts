import { App, PluginSettingTab, Setting } from "obsidian";
import type ReviewTrackerPlugin from "./main";

export class ReviewTrackerSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: ReviewTrackerPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName("Color thresholds").setHeading();

    const s = this.plugin.settings;

    const numberSetting = (
      name: string,
      desc: string,
      get: () => number,
      set: (v: number) => void,
    ) => {
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addText((text) =>
          text
            .setPlaceholder("days")
            .setValue(String(get()))
            .onChange(async (raw) => {
              const v = Number(raw);
              if (!Number.isFinite(v) || v < 0) return;
              set(Math.floor(v));
              await this.plugin.saveSettings();
            }),
        );
    };

    numberSetting("Green up to", "Overdue by at most this many days.",
      () => s.greenMaxDays, (v) => (s.greenMaxDays = v));
    numberSetting("Yellow up to", "Overdue by at most this many days.",
      () => s.yellowMaxDays, (v) => (s.yellowMaxDays = v));
    numberSetting("Orange up to", "Overdue by at most this many days. Older turns red.",
      () => s.orangeMaxDays, (v) => (s.orangeMaxDays = v));

    numberSetting("Grading cooldown (minutes)",
      "Lock a note's grade buttons for this long after grading. 0 disables it.",
      () => s.cooldownMinutes, (v) => (s.cooldownMinutes = v));

    new Setting(containerEl).setName("Behavior").setHeading();

    new Setting(containerEl)
      .setName("Use modified date for un-reviewed notes")
      .setDesc("Color notes with no last_reviewed value by the file's modified date.")
      .addToggle((toggle) =>
        toggle.setValue(s.useModifiedAsFallback).onChange(async (v) => {
          s.useModifiedAsFallback = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Write status property for graph colors")
      .setDesc("Maintain a review_status property so the graph view can color nodes via color groups.")
      .addToggle((toggle) =>
        toggle.setValue(s.writeStatusProperty).onChange(async (v) => {
          s.writeStatusProperty = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Keep date fields as plain text")
      .setDesc("Force last_reviewed and sr_due to the Text property type.")
      .addToggle((toggle) =>
        toggle.setValue(s.forceTextDateProps).onChange(async (v) => {
          s.forceTextDateProps = v;
          await this.plugin.saveSettings();
        }),
      );
  }
}
