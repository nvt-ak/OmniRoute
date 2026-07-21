"use client";

import { SlackConfigForm, type SlackConfig } from "./integrations/SlackConfigForm";
import { TelegramConfigForm, type TelegramConfig } from "./integrations/TelegramConfigForm";
import { DiscordConfigForm, type DiscordConfig } from "./integrations/DiscordConfigForm";
import { MsTeamsConfigForm, type MsTeamsConfig } from "./integrations/MsTeamsConfigForm";
import { CustomConfigForm, type CustomConfig } from "./integrations/CustomConfigForm";
import type { WebhookKind } from "../shared/IntegrationCard";

interface Step2ConfigureIntegrationProps {
  kind: WebhookKind;
  slack: SlackConfig;
  telegram: TelegramConfig;
  discord: DiscordConfig;
  msteams: MsTeamsConfig;
  custom: CustomConfig;
  onChangeSlack: (v: SlackConfig) => void;
  onChangeTelegram: (v: TelegramConfig) => void;
  onChangeDiscord: (v: DiscordConfig) => void;
  onChangeMsTeams: (v: MsTeamsConfig) => void;
  onChangeCustom: (v: CustomConfig) => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
  isEditing?: boolean;
}

export function Step2ConfigureIntegration({
  kind,
  slack,
  telegram,
  discord,
  msteams,
  custom,
  onChangeSlack,
  onChangeTelegram,
  onChangeDiscord,
  onChangeMsTeams,
  onChangeCustom,
  t,
  isEditing,
}: Step2ConfigureIntegrationProps) {
  if (kind === "slack") return <SlackConfigForm value={slack} onChange={onChangeSlack} t={t} />;
  if (kind === "telegram")
    return (
      <TelegramConfigForm
        value={telegram}
        onChange={onChangeTelegram}
        t={t}
        isEditing={isEditing}
      />
    );
  if (kind === "discord")
    return <DiscordConfigForm value={discord} onChange={onChangeDiscord} t={t} />;
  if (kind === "msteams")
    return <MsTeamsConfigForm value={msteams} onChange={onChangeMsTeams} t={t} />;
  return <CustomConfigForm value={custom} onChange={onChangeCustom} t={t} isEditing={isEditing} />;
}

export type { SlackConfig, TelegramConfig, DiscordConfig, MsTeamsConfig, CustomConfig };
