const { ApplicationCommandOptionType, MessageFlags } = require("discord.js");
const config = require("../config");
const { success, error } = require("../utils/embeds");
const { logEvent } = require("../utils/logger");
const { scheduleRefresh } = require("../utils/liveEmbeds");
const { hashKey } = require("../utils/recovery");
const userSchema = require("../db/models/userSchema");
const recoveryKeySchema = require("../db/models/recoveryKeySchema");

// Note: generating a recovery key now lives on `/user` (the "Generate recovery
// key" button). This command only REDEEMS a key onto your account.
module.exports = {
  name: "recoverbalance",
  category: "Economy",
  description: "Redeem a recovery key to move that balance onto your account",
  hidden: false,
  options: [
    {
      name: "use",
      description: "Redeem a recovery key to move that balance onto your account",
      type: ApplicationCommandOptionType.Subcommand,
      options: [
        {
          name: "key",
          description: "The recovery key you saved (e.g. RK-XXXX-XXXX-…)",
          type: ApplicationCommandOptionType.String,
          required: true,
        },
      ],
    },
  ],

  callback: async (client, interaction) => {
    const guildId = interaction.guild.id;

    switch (interaction.options.getSubcommand()) {
      case "use": {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const rawKey = interaction.options.getString("key");
        const keyHash = hashKey(rawKey);

        // Atomically claim the key: delete it and get the owning record back, so
        // two people can't redeem the same key (the key is single-use).
        const claimed = await recoveryKeySchema.findOneAndDelete({ guildId, keyHash });
        if (!claimed) {
          return interaction.followUp({
            embeds: [error(interaction, "That recovery key is invalid or has already been used.")],
            flags: MessageFlags.Ephemeral,
          });
        }

        const sourceUserId = claimed.userId;
        const targetUserId = interaction.user.id;

        if (sourceUserId === targetUserId) {
          // Redeeming your own key on the same account is a no-op; put it back so
          // it isn't wasted.
          await recoveryKeySchema.create({ guildId, userId: sourceUserId, keyHash });
          return interaction.followUp({
            embeds: [error(interaction, "This key belongs to the account you're already using — nothing to recover.")],
            flags: MessageFlags.Ephemeral,
          });
        }

        // Move the source balance onto the target account. Zero the source
        // atomically and read how much it held, then credit the target.
        const source = await userSchema.findOneAndUpdate(
          { guildId, userId: sourceUserId },
          { $set: { userBalance: 0 } },
          { new: false }
        );
        const moved = Number(source?.userBalance) || 0;

        let target;
        try {
          target = await userSchema.findOneAndUpdate(
            { guildId, userId: targetUserId },
            { $inc: { userBalance: moved }, $setOnInsert: { guildId, userId: targetUserId } },
            { upsert: true, new: true }
          );
        } catch (err) {
          // Put everything back: the source balance and the key.
          if (moved) await userSchema.updateOne({ guildId, userId: sourceUserId }, { $inc: { userBalance: moved } }).catch(() => {});
          await recoveryKeySchema.create({ guildId, userId: sourceUserId, keyHash }).catch(() => {});
          throw err;
        }

        scheduleRefresh(client, guildId, { store: false, leaderboard: true });

        await logEvent(client, guildId, {
          type: "balance",
          title: "Balance Recovered",
          userId: targetUserId,
          fields: [
            { name: "From (lost account)", value: `<@${sourceUserId}>`, inline: true },
            { name: "To", value: `<@${targetUserId}>`, inline: true },
            { name: "Amount", value: `${moved} ${config.currency}`, inline: true },
          ],
        });

        return interaction.followUp({
          embeds: [
            success(
              interaction,
              `Recovered **${moved}** ${config.currency} onto your account. New balance: **${target.userBalance}** ${config.currency}.`
            ),
          ],
          flags: MessageFlags.Ephemeral,
        });
      }
    }
  },
};
