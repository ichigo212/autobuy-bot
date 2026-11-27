const { PermissionFlagsBits, MessageFlags } = require("discord.js");
const config = require("../config");

// ---------------------------------------------------------------------------
// Access levels
//   Main owner  = listed in OWNER_IDS (.env). Can add/remove admins.
//   Owner       = main owner, OR an admin user/role added with
//                 /announcement addowner (per server). Full access.
//   Staff       = owner, OR a configured staff role, OR Manage Server.
// Added admins are kept in memory (loaded at startup, updated on every
// add/remove) so these checks stay synchronous.
// ---------------------------------------------------------------------------

const adminCache = new Map(); // guildId -> { users: Set, roles: Set }

const setAdmins = (guildId, users = [], roles = []) => {
  adminCache.set(guildId, { users: new Set(users), roles: new Set(roles) });
};

const getAdmins = (guildId) => {
  const a = adminCache.get(guildId);
  return { users: [...(a?.users || [])], roles: [...(a?.roles || [])] };
};

const loadAdmins = async () => {
  const guildConfigSchema = require("../db/models/guildConfigSchema");
  const docs = await guildConfigSchema
    .find({ $or: [{ adminUserIds: { $exists: true, $ne: [] } }, { adminRoleIds: { $exists: true, $ne: [] } }] }, { guildId: 1, adminUserIds: 1, adminRoleIds: 1 })
    .lean();
  adminCache.clear();
  for (const d of docs) setAdmins(d.guildId, d.adminUserIds, d.adminRoleIds);
  return docs.length;
};

// Role IDs of the member behind an interaction (cached GuildMember or raw API member).
const memberRoleIds = (member) => {
  if (member?.roles?.cache) return [...member.roles.cache.keys()];
  if (Array.isArray(member?.roles)) return member.roles;
  return [];
};

const isMainOwner = (interaction) => config.ownerIds.includes(interaction.user.id);

const isAddedAdmin = (interaction) => {
  const admins = adminCache.get(interaction.guildId ?? interaction.guild?.id);
  if (!admins) return false;
  if (admins.users.has(interaction.user.id)) return true;
  return memberRoleIds(interaction.member).some((id) => admins.roles.has(id));
};

const isOwner = (interaction) => isMainOwner(interaction) || isAddedAdmin(interaction);

const isStaff = (interaction) => {
  if (isOwner(interaction)) return true;

  const member = interaction.member;
  if (!member) return false;

  if (member.permissions?.has?.(PermissionFlagsBits.ManageGuild)) return true;

  const roles = memberRoleIds(member);
  return config.staffRoleIds.some((roleId) => roles.includes(roleId));
};

const deny = async (interaction, content) => {
  await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
  return false;
};

// Convenience guards: reply with a denial and return false when not allowed.
const requireStaff = async (interaction) => isStaff(interaction) || deny(interaction, "You don't have permission to use this command.");
const requireOwner = async (interaction) => isOwner(interaction) || deny(interaction, "This command is restricted to bot owners and admins.");
const requireMainOwner = async (interaction) =>
  isMainOwner(interaction) || deny(interaction, "Only the main bot owner (OWNER_IDS in the bot's `.env`) can add or remove admins.");

module.exports = {
  isMainOwner,
  isOwner,
  isStaff,
  requireStaff,
  requireOwner,
  requireMainOwner,
  loadAdmins,
  setAdmins,
  getAdmins,
};
