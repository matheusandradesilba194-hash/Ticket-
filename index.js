const {
    Client,
    GatewayIntentBits,
    REST,
    Routes,
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    ButtonBuilder,
    ButtonStyle,
    PermissionFlagsBits,
    ChannelType,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle
} = require('discord.js');
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
require('dotenv').config();

const DISCORD_TOKEN = String(process.env.DISCORD_BOT_TOKEN || process.env.DISCORD_TOKEN || '').trim();
if (!DISCORD_TOKEN) {
    console.error('DISCORD_BOT_TOKEN não foi configurado nas variáveis da Railway.');
    process.exit(1);
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

const DATA_DIR = process.env.DATA_DIR || __dirname;
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const KEYS_FILE = path.join(DATA_DIR, 'keys.json');
const DEFAULT_SCRIPT = "loadstring(game:HttpGet('https://server-theta-snowy.vercel.app/getscript?key={KEY}'))()";

const defaultConfig = {
    ticketCategory: '',
    staffRole: '',
    buyerRoleId: process.env.DISCORD_BUYER_ROLE_ID || '',
    logChannel: '',
    panelTitle: '🛡️ Central de Suporte',
    panelDescription: 'Selecione abaixo a categoria que melhor descreve o seu problema e nossa equipe entrará em contato em um canal privado exclusivo para você.',
    panelThumb: process.env.HYDRA_THUMB || '',
    pixKey: process.env.PIX_KEY || 'Não configurada',
    pixName: process.env.PIX_NAME || 'Beneficiário',
    pixCity: process.env.PIX_CITY || 'Cidade',
    scriptTemplate: process.env.SCRIPT_TEMPLATE || DEFAULT_SCRIPT,
    scriptPanelTitle: '🔑 Hydra Script Panel',
    scriptPanelDescription: 'Use os botões abaixo para gerenciar sua Key.',
    scriptPanelThumb: process.env.HYDRA_THUMB || '',
    statsChannelId: process.env.DISCORD_STATUS_CHANNEL_ID || '',
    statsMessageId: ''
};

function readJson(file, fallback) {
    try {
        if (!fs.existsSync(file)) return fallback;
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
        console.error(`Erro ao ler ${file}:`, error);
        return fallback;
    }
}

let config = { ...defaultConfig, ...readJson(CONFIG_FILE, {}) };
// IDs definidos na Railway sempre vencem valores antigos salvos em config.json.
if (process.env.DISCORD_BUYER_ROLE_ID) config.buyerRoleId = process.env.DISCORD_BUYER_ROLE_ID.trim();
if (process.env.DISCORD_STATUS_CHANNEL_ID) config.statsChannelId = process.env.DISCORD_STATUS_CHANNEL_ID.trim();
let keys = readJson(KEYS_FILE, []);
let statsUpdateInterval = null;

function saveJson(file, value) {
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function saveConfig() {
    saveJson(CONFIG_FILE, config);
}

function saveKeys() {
    saveJson(KEYS_FILE, keys);
}

function apiSecretIsValid(req) {
    const expected = String(process.env.LICENSE_API_SECRET || '').trim();
    if (!expected) return true;
    const supplied = String(req.get('x-api-secret') || req.query.secret || '').trim();
    return supplied === expected;
}

function findLicenseKey(value) {
    const submitted = String(value || '').trim().toUpperCase();
    return keys.find(item => item.key === submitted);
}

function licensePayload(key) {
    const permanent = !key.expiresAt;
    const remaining = permanent ? null : Math.max(0, new Date(key.expiresAt).getTime() - Date.now());
    return {
        status: 'success',
        key: key.key,
        user_id: key.userId || null,
        hwid: key.hwid || null,
        expires_at: key.expiresAt || null,
        time_left: remaining,
        permanent
    };
}

function validateLicenseRequest(req, res, options = {}) {
    if (!apiSecretIsValid(req)) {
        res.status(401).json({ status: 'error', message: 'Unauthorized' });
        return null;
    }
    const key = findLicenseKey(req.query.key || req.body?.key);
    if (!key) {
        res.status(404).json({ status: 'error', message: 'Key inválida' });
        return null;
    }
    if (key.revoked) {
        res.status(403).json({ status: 'error', message: 'Key revogada' });
        return null;
    }
    if (key.expiresAt && new Date(key.expiresAt).getTime() <= Date.now()) {
        res.status(403).json({ status: 'error', message: 'Key expirada' });
        return null;
    }
    const hwid = String(req.query.hwid || req.body?.hwid || '').trim();
    if (hwid) {
        if (key.hwid && key.hwid !== hwid) {
            res.status(403).json({ status: 'error', message: 'HWID inválido' });
            return null;
        }
        if (!key.hwid) {
            key.hwid = hwid;
            key.hwidBoundAt = new Date().toISOString();
            saveKeys();
        }
    }
    if (options.touch) {
        key.lastValidatedAt = new Date().toISOString();
        saveKeys();
    }
    return key;
}

function startLicenseApi() {
    const app = express();
    app.use(cors());
    app.use(express.json({ limit: '32kb' }));

    app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'hydra-license-api' }));

    app.get('/validate', (req, res) => {
        const key = validateLicenseRequest(req, res, { touch: true });
        if (!key) return;
        res.json(licensePayload(key));
    });

    app.get('/getscript', (req, res) => {
        const key = validateLicenseRequest(req, res, { touch: true });
        if (!key) return;
        const source = renderScript(key.key);
        res.type('text/plain').send(source);
    });

    app.get('/kicked', (req, res) => {
        if (!apiSecretIsValid(req)) return res.status(401).json({ status: 'error', message: 'Unauthorized' });
        const key = findLicenseKey(req.query.key);
        const invalid = !key || key.revoked || (key.expiresAt && new Date(key.expiresAt).getTime() <= Date.now());
        res.json({ kicked: Boolean(invalid) });
    });

    app.all('/reset-hwid', (req, res) => {
        const key = validateLicenseRequest(req, res);
        if (!key) return;
        key.hwid = null;
        key.hwidResetAt = new Date().toISOString();
        saveKeys();
        res.json({ status: 'success', message: 'HWID resetado' });
    });

    app.post('/presence', (req, res) => {
        if (!apiSecretIsValid(req)) return res.status(401).json({ status: 'error', message: 'Unauthorized' });
        res.json({ status: 'ok' });
    });

    const port = Number(process.env.PORT || 3000);
    app.listen(port, '0.0.0.0', () => console.log(`API de Keys online na porta ${port}.`));
}

function isAdmin(interaction) {
    return interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) === true;
}

function formatDate(value) {
    if (!value) return 'Nunca';
    return `<t:${Math.floor(new Date(value).getTime() / 1000)}:f>`;
}

function remainingTime(value) {
    if (!value) return 'Permanente';
    const difference = new Date(value).getTime() - Date.now();
    if (difference <= 0) return 'Expirada';
    const totalMinutes = Math.floor(difference / 60000);
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;
    const parts = [];
    if (days) parts.push(`${days}d`);
    if (hours) parts.push(`${hours}h`);
    if (minutes || !parts.length) parts.push(`${minutes}m`);
    return parts.join(' ');
}

function liveTime(value) {
    if (!value) return 'Permanente';
    const timestamp = Math.floor(new Date(value).getTime() / 1000);
    return `<t:${timestamp}:R>`;
}

function statusOf(key) {
    if (key.revoked) return 'Revogada';
    if (key.expiresAt && new Date(key.expiresAt).getTime() <= Date.now()) return 'Expirada';
    if (key.userId) return 'Em uso';
    return 'Disponível';
}

function generateKey() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let part = '';
    for (let i = 0; i < 12; i++) {
        part += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    return `HYDRA-${part}`;
}

function parseDuration(duration) {
    const normalized = String(duration || '').trim().toLowerCase();
    if (normalized === 'permanente' || normalized === 'perm' || normalized === '0') return null;
    const match = normalized.match(/^(\d+)\s*(m|min|h|d|dia|dias|w|semana|semanas|mo|mês|mes|meses)$/i);
    if (!match) return undefined;
    const amount = Number(match[1]);
    const unit = match[2];
    const multipliers = {
        m: 60 * 1000,
        min: 60 * 1000,
        h: 60 * 60 * 1000,
        d: 24 * 60 * 60 * 1000,
        dia: 24 * 60 * 60 * 1000,
        dias: 24 * 60 * 60 * 1000,
        w: 7 * 24 * 60 * 60 * 1000,
        semana: 7 * 24 * 60 * 60 * 1000,
        semanas: 7 * 24 * 60 * 60 * 1000,
        mo: 30 * 24 * 60 * 60 * 1000,
        mês: 30 * 24 * 60 * 60 * 1000,
        mes: 30 * 24 * 60 * 60 * 1000,
        meses: 30 * 24 * 60 * 60 * 1000
    };
    return Date.now() + amount * multipliers[unit];
}

function renderScript(key) {
    let source = String(config.scriptTemplate || DEFAULT_SCRIPT).replaceAll('{KEY}', key).trim();
    // Evita que uma Key colada por engano após o loadstring seja enviada ao usuário.
    const normalizedSource = source.toUpperCase();
    const normalizedKey = String(key).toUpperCase();
    if (normalizedSource.endsWith(normalizedKey)) {
        source = source.slice(0, source.length - String(key).length).trim();
    }
    if (/^https?:\/\//i.test(source)) {
        const safeUrl = source.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        source = `loadstring(game:HttpGet("${safeUrl}"))()`;
    }
    return source;
}

function formatKeyScript(key) {
    const safeKey = String(key).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return '```lua\ngetgenv().HYDRA_KEY = "' + safeKey + '"\n' + renderScript(key) + '\n```';
}

function getKeysForUser(userId) {
    return keys.filter(key => key.userId === userId);
}

function buildScriptPanelEmbed() {
    const embed = new EmbedBuilder()
        .setTitle(config.scriptPanelTitle || '🔑 Hydra Script Panel')
        .setDescription(config.scriptPanelDescription || 'Use os botões abaixo para gerenciar sua Key.')
        .setColor(0x3498DB)
        .setFooter({ text: 'Hydra Key System' });
    const thumbnail = config.scriptPanelThumb || config.panelThumb || process.env.HYDRA_THUMB;
    if (thumbnail && /^https?:\/\//i.test(thumbnail)) embed.setThumbnail(thumbnail);
    return embed;
}

function buildScriptPanelRows() {
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('script_view').setLabel('View Script').setStyle(ButtonStyle.Primary).setEmoji('📜'),
            new ButtonBuilder().setCustomId('script_redeem').setLabel('Redeem Key').setStyle(ButtonStyle.Success).setEmoji('🔑'),
            new ButtonBuilder().setCustomId('script_reset_hwid').setLabel('Reset HWID').setStyle(ButtonStyle.Danger).setEmoji('⚙️')
        )
    ];
}

function getStats() {
    const valid = keys.filter(k => !k.revoked && (!k.expiresAt || new Date(k.expiresAt).getTime() > Date.now()));
    return {
        total: keys.length,
        active: valid.length,
        inUse: valid.filter(k => k.userId).length,
        available: valid.filter(k => !k.userId).length,
        expired: keys.filter(k => statusOf(k) === 'Expirada').length,
        revoked: keys.filter(k => k.revoked).length
    };
}

async function updateStatsMessage() {
    const channelId = config.statsChannelId || process.env.DISCORD_STATUS_CHANNEL_ID;
    if (!channelId) return false;
    try {
        const channel = await client.channels.fetch(channelId);
        if (!channel || !channel.isTextBased()) return false;
        let message = null;
        if (config.statsMessageId) message = await channel.messages.fetch(config.statsMessageId).catch(() => null);
        if (message) {
            await message.edit({ embeds: [buildStatsEmbed()] });
        } else {
            message = await channel.send({ embeds: [buildStatsEmbed()] });
            config.statsChannelId = channel.id;
            config.statsMessageId = message.id;
            saveConfig();
        }
        console.log(`Status Hydra atualizado automaticamente em ${new Date().toISOString()}.`);
        return true;
    } catch (error) {
        console.error('Não foi possível atualizar o status Hydra:', error.message);
        return false;
    }
}

async function syncExpiredBuyerRoles() {
    if (!config.buyerRoleId || !client.guilds?.cache?.size) return;
    let changed = false;
    for (const key of keys) {
        if (!key.userId || key.revoked || statusOf(key) !== 'Expirada' || key.roleRemovedAt) continue;
        const hasAnotherActiveKey = keys.some(other => other !== key && other.userId === key.userId && !other.revoked && statusOf(other) === 'Em uso');
        if (hasAnotherActiveKey) continue;
        for (const guild of client.guilds.cache.values()) {
            const role = guild.roles.cache.get(config.buyerRoleId);
            if (!role) continue;
            const member = await guild.members.fetch(key.userId).catch(() => null);
            if (!member) continue;
            if (member.roles.cache.has(role.id)) await member.roles.remove(role, 'Key Hydra expirada').catch(() => {});
        }
        key.roleRemovedAt = new Date().toISOString();
        changed = true;
    }
    if (changed) saveKeys();
}

function startStatsUpdater() {
    if (statsUpdateInterval) clearInterval(statsUpdateInterval);
    const refresh = async () => {
        await syncExpiredBuyerRoles();
        await updateStatsMessage();
    };
    refresh().catch(error => console.error('Erro no atualizador do stats:', error.message));
    statsUpdateInterval = setInterval(() => {
        refresh().catch(error => console.error('Erro no atualizador do stats:', error.message));
    }, 15 * 1000);
}

function buildStatsEmbed() {
    const stats = getStats();
    const users = keys.filter(k => k.userId && statusOf(k) === 'Em uso').slice(0, 30);
    const userLines = users.length
        ? users.map((k, index) => `${index + 1}. <@${k.userId}> — **${remainingTime(k.expiresAt)}** · ${liveTime(k.expiresAt)} — expira ${formatDate(k.expiresAt)}`).join('\n')
        : 'Nenhuma assinatura ativa no momento.';

    const embed = new EmbedBuilder()
        .setTitle('📊 Hydra Slots Status')
        .setColor(0x3498DB)
        .setDescription('Confira abaixo o status atual das Keys e das assinaturas do Hydra.')
        .addFields(
            { name: '📦 Remaining Slots', value: `**${stats.available}** vaga(s) disponível(is)`, inline: false },
            { name: '✨ Hydra Keys', value: `**${stats.inUse}/${stats.active}** em uso`, inline: true },
            { name: '✅ Ativas', value: `**${stats.active}**`, inline: true },
            { name: '⏳ Expiradas', value: `**${stats.expired}**`, inline: true },
            { name: '👥 Subscriptions', value: userLines, inline: false }
        )
        .setFooter({ text: `Hydra Key Manager • ${stats.total} Keys cadastradas` })
        .setTimestamp();

    const thumbnail = config.panelThumb || process.env.HYDRA_THUMB;
    if (thumbnail && /^https?:\/\//i.test(thumbnail)) embed.setThumbnail(thumbnail);
    return embed;
}

const commands = [
    new SlashCommandBuilder().setName('setup').setDescription('Painel administrativo do bot').setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder().setName('painel').setDescription('Envia o painel de tickets').setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder().setName('painelpx').setDescription('Envia o painel de compra via Pix')
        .addStringOption(o => o.setName('valor').setDescription('Valor do produto').setRequired(false))
        .addStringOption(o => o.setName('descricao').setDescription('Descrição do painel').setRequired(false))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder().setName('generate-key').setDescription('Gera uma ou várias Keys Hydra')
        .addStringOption(o => o.setName('tempo').setDescription('Ex.: 7d, 30d, 12h ou permanente').setRequired(true))
        .addIntegerOption(o => o.setName('quantidade').setDescription('Quantidade de Keys (1 a 100)').setMinValue(1).setMaxValue(100).setRequired(false))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder().setName('check-keys').setDescription('Mostra todas as Keys e seus usuários')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder().setName('status').setDescription('Envia ou atualiza o status automático do Hydra')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder().setName('set-thumb').setDescription('Define a thumbnail do painel de estatísticas')
        .addStringOption(o => o.setName('url').setDescription('URL direta da imagem PNG, JPG ou GIF').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder().setName('set-script').setDescription('Configura o script entregue com cada Key')
        .addStringOption(o => o.setName('script').setDescription('Use {KEY} no ponto onde a Key deve entrar').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder().setName('painel-script').setDescription('Envia o painel de Keys e script')
        .addStringOption(o => o.setName('titulo').setDescription('Título do painel').setRequired(false))
        .addStringOption(o => o.setName('descricao').setDescription('Descrição exibida no painel').setRequired(false))
        .addStringOption(o => o.setName('thumbnail').setDescription('URL da thumbnail').setRequired(false))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder().setName('set-buyer-role').setDescription('Define o cargo recebido por compradores')
        .addRoleOption(o => o.setName('cargo').setDescription('Cargo de comprador').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder().setName('set-comp').setDescription('Adiciona tempo à Key de um usuário')
        .addUserOption(o => o.setName('user').setDescription('Usuário que receberá o tempo adicional').setRequired(true))
        .addStringOption(o => o.setName('tempo').setDescription('Ex.: 7d, 30d, 12h ou permanente').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder().setName('remover-key').setDescription('Revoga a Key e remove o acesso ao script')
        .addUserOption(o => o.setName('user').setDescription('Usuário dono da Key').setRequired(true))
        .addStringOption(o => o.setName('key').setDescription('Key que será removida').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
].map(command => command.toJSON());

client.once('ready', async () => {
    console.log(`Bot online como ${client.user.tag}!`);
    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
    try {
        const guildId = process.env.DISCORD_GUILD_ID?.trim();
        const globalRoute = Routes.applicationCommands(client.user.id);
        const commandRoute = guildId ? Routes.applicationGuildCommands(client.user.id, guildId) : globalRoute;
        const legacyCommandName = ['redeem', 'key'].join('-');
        const registeredCommands = await rest.get(commandRoute);
        const legacyCommands = registeredCommands.filter(command => command.name === legacyCommandName);
        for (const legacyCommand of legacyCommands) {
            await rest.delete(guildId ? Routes.applicationGuildCommand(client.user.id, guildId, legacyCommand.id) : Routes.applicationCommand(client.user.id, legacyCommand.id));
        }
        if (guildId) await rest.put(globalRoute, { body: [] }).catch(() => {});
        await rest.put(commandRoute, { body: commands });
        const registeredNames = commands.map(command => `/${command.name}`).join(', ');
        console.log(`${guildId ? 'Comandos registrados no servidor' : 'Comandos registrados globalmente'}: ${registeredNames}`);
    } catch (error) {
        console.error('Erro ao registrar comandos:', error);
    }
    startStatsUpdater();
    updateStatsMessage().catch(error => console.error('Erro ao atualizar o stats ao iniciar:', error.message));
});

client.on('interactionCreate', async interaction => {
    try {
        if (interaction.isChatInputCommand()) {
            if (['generate-key', 'check-keys', 'status', 'set-thumb', 'set-script', 'painel-script', 'set-buyer-role', 'set-comp', 'remover-key', 'setup', 'painel', 'painelpx'].includes(interaction.commandName) && !isAdmin(interaction)) {
                return interaction.reply({ content: '❌ Apenas administradores podem usar este comando.', ephemeral: true });
            }

            if (interaction.commandName === 'generate-key') {
                const expiresAt = parseDuration(interaction.options.getString('tempo'));
                if (expiresAt === undefined) return interaction.reply({ content: '❌ Tempo inválido. Use formatos como `7d`, `30d`, `12h` ou `permanente`.', ephemeral: true });
                const quantity = interaction.options.getInteger('quantidade') || 1;
                const created = [];
                for (let i = 0; i < quantity; i++) {
                    let key;
                    do { key = generateKey(); } while (keys.some(k => k.key === key));
                    keys.push({
                        key,
                        createdAt: new Date().toISOString(),
                        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
                        userId: null,
                        userTag: null,
                        activatedAt: null,
                        revoked: false
                    });
                    created.push(key);
                }
                saveKeys();
                await updateStatsMessage();
                const deliveries = created.join('\n');
                return interaction.reply({ content: `✅ ${quantity} Key(s) criada(s) e disponíveis para resgate.\nValidade: **${expiresAt ? formatDate(expiresAt) : 'Permanente'}**\n\n🔑 Keys:\n${deliveries}`, ephemeral: true });
            }

            if (interaction.commandName === 'set-comp') {
                const recipient = interaction.options.getUser('user', true);
                if (recipient.bot) return interaction.reply({ content: '❌ Selecione um usuário real, não um bot.', ephemeral: true });
                const duration = parseDuration(interaction.options.getString('tempo'));
                if (duration === undefined) return interaction.reply({ content: '❌ Tempo inválido. Use `7d`, `30d`, `12h` ou `permanente`.', ephemeral: true });
                const userKeys = keys.filter(key => key.userId === recipient.id && !key.revoked && statusOf(key) !== 'Expirada');
                if (!userKeys.length) return interaction.reply({ content: `❌ ${recipient} não possui uma Key ativa vinculada.`, ephemeral: true });
                const key = userKeys.sort((a, b) => new Date(b.expiresAt || 0) - new Date(a.expiresAt || 0))[0];
                if (duration === null) {
                    key.expiresAt = null;
                } else {
                    const currentExpiry = key.expiresAt && new Date(key.expiresAt).getTime() > Date.now() ? new Date(key.expiresAt).getTime() : Date.now();
                    const extraMs = duration - Date.now();
                    key.expiresAt = new Date(currentExpiry + Math.max(0, extraMs)).toISOString();
                }
                key.updatedAt = new Date().toISOString();
                key.roleRemovedAt = null;
                saveKeys();
                await updateStatsMessage();
                const label = duration === null ? 'permanente' : `até ${formatDate(key.expiresAt)}`;
                return interaction.reply({ content: `✅ Tempo adicionado à Key de ${recipient}. Validade atualizada: **${label}**.`, ephemeral: true });
            }

            if (interaction.commandName === 'remover-key') {
                const recipient = interaction.options.getUser('user', true);
                if (recipient.bot) return interaction.reply({ content: '❌ Selecione um usuário real, não um bot.', ephemeral: true });
                const submitted = interaction.options.getString('key', true).trim().toUpperCase();
                const key = keys.find(item => item.key === submitted && item.userId === recipient.id);
                if (!key) return interaction.reply({ content: `❌ A Key informada não está vinculada a ${recipient}.`, ephemeral: true });
                if (key.revoked) return interaction.reply({ content: '❌ Essa Key já foi removida anteriormente.', ephemeral: true });

                key.revoked = true;
                key.revokedAt = new Date().toISOString();
                key.revokedBy = interaction.user.id;
                key.hwid = null;
                key.lastValidatedAt = null;
                key.roleRemovedAt = new Date().toISOString();

                const anotherActiveKey = keys.some(other =>
                    other !== key &&
                    other.userId === recipient.id &&
                    !other.revoked &&
                    statusOf(other) !== 'Expirada'
                );

                let roleRemoved = false;
                if (!anotherActiveKey && config.buyerRoleId) {
                    for (const guild of client.guilds.cache.values()) {
                        const role = guild.roles.cache.get(config.buyerRoleId);
                        if (!role) continue;
                        const member = await guild.members.fetch(recipient.id).catch(() => null);
                        if (member?.roles.cache.has(role.id)) {
                            await member.roles.remove(role, 'Key Hydra removida pelo administrador').then(() => {
                                roleRemoved = true;
                            }).catch(() => {});
                        }
                    }
                }

                saveKeys();
                await updateStatsMessage();
                const roleMessage = roleRemoved ? ' O cargo Buyer também foi removido.' : anotherActiveKey ? ' O cargo Buyer foi mantido porque existe outra Key ativa.' : '';
                return interaction.reply({ content: `✅ Key **${key.key}** removida de ${recipient}.${roleMessage}`, ephemeral: true });
            }

            if (interaction.commandName === 'set-buyer-role') {
                const role = interaction.options.getRole('cargo', true);
                config.buyerRoleId = role.id;
                saveConfig();
                return interaction.reply({ content: `✅ O cargo de comprador foi definido como ${role}.`, ephemeral: true });
            }

            if (interaction.commandName === 'painel-script') {
                const title = interaction.options.getString('titulo');
                const description = interaction.options.getString('descricao');
                const thumbnail = interaction.options.getString('thumbnail');
                if (title) config.scriptPanelTitle = title;
                if (description) config.scriptPanelDescription = description;
                if (thumbnail) {
                    if (!/^https?:\/\//i.test(thumbnail)) return interaction.reply({ content: '❌ A thumbnail precisa ser uma URL começando com http:// ou https://.', ephemeral: true });
                    config.scriptPanelThumb = thumbnail;
                }
                saveConfig();
                await interaction.reply({ content: '✅ Painel de script publicado.', ephemeral: true });
                return interaction.channel.send({ embeds: [buildScriptPanelEmbed()], components: buildScriptPanelRows() });
            }

            if (interaction.commandName === 'check-keys') {
                if (!keys.length) return interaction.reply({ content: 'Nenhuma Key foi criada ainda.', ephemeral: true });
                const lines = keys.slice(0, 50).map(k => `\`${k.key}\` — **${statusOf(k)}** — ${k.userId ? `<@${k.userId}>` : 'sem usuário'} — expira ${formatDate(k.expiresAt)}`);
                return interaction.reply({ embeds: [new EmbedBuilder().setTitle('🔑 Todas as Keys Hydra').setColor(0x3498DB).setDescription(lines.join('\n')).setFooter({ text: keys.length > 50 ? `Exibindo 50 de ${keys.length} Keys` : `${keys.length} Key(s)` })], ephemeral: true });
            }

            if (interaction.commandName === 'status') {
                const statsMessage = await interaction.channel.send({ embeds: [buildStatsEmbed()] });
                config.statsChannelId = interaction.channel.id;
                config.statsMessageId = statsMessage.id;
                saveConfig();
                startStatsUpdater();
                return interaction.reply({ content: '✅ Painel de estatísticas azul enviado. O tempo será atualizado automaticamente.', ephemeral: true });
            }

            if (interaction.commandName === 'set-thumb') {
                const url = interaction.options.getString('url').trim();
                if (!/^https?:\/\//i.test(url)) return interaction.reply({ content: '❌ Informe uma URL começando com `https://` ou `http://`.', ephemeral: true });
                if (url.length > 500) return interaction.reply({ content: '❌ A URL da thumbnail é muito longa.', ephemeral: true });
                config.panelThumb = url;
                saveConfig();
                return interaction.reply({ content: '✅ Thumbnail salva. O próximo status automático usará essa imagem.', ephemeral: true });
            }

            if (interaction.commandName === 'set-script') {
                const script = interaction.options.getString('script');
                if (!script.includes('{KEY}')) return interaction.reply({ content: '❌ O script precisa conter o marcador `{KEY}`. Exemplo: `...?key={KEY}`.', ephemeral: true });
                if (script.length > 4000) return interaction.reply({ content: '❌ O script excede o limite de 4000 caracteres.', ephemeral: true });
                config.scriptTemplate = script;
                saveConfig();
                return interaction.reply({ content: `✅ Script configurado. Ao gerar uma Key, ela será inserida no lugar de **{KEY}**.\n\nPrévia:\n\`\`\`lua\n${renderScript('HYDRA-EXEMPLO1234')}\n\`\`\``, ephemeral: true });
            }

            if (interaction.commandName === 'setup') {
                const embed = new EmbedBuilder().setTitle('⚙️ Configurações do Sistema').setDescription('Gerencie tickets, Pix e o sistema de Keys.').setColor(0x3498DB).addFields(
                    { name: 'Categoria de tickets', value: config.ticketCategory ? `<#${config.ticketCategory}>` : 'Não definida', inline: true },
                    { name: 'Cargo Staff', value: config.staffRole ? `<@&${config.staffRole}>` : 'Não definido', inline: true },
                    { name: 'Canal de logs', value: config.logChannel ? `<#${config.logChannel}>` : 'Não definido', inline: true },
                    { name: 'Keys cadastradas', value: String(keys.length), inline: true },
                    { name: 'Script configurado', value: config.scriptTemplate ? 'Sim' : 'Não', inline: true }
                );
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('conf_tickets').setLabel('Canais e Cargos').setStyle(ButtonStyle.Primary).setEmoji('🎫'),
                    new ButtonBuilder().setCustomId('conf_desc').setLabel('Texto e Imagem').setStyle(ButtonStyle.Secondary).setEmoji('✍️'),
                    new ButtonBuilder().setCustomId('conf_pix').setLabel('Configurar Pix').setStyle(ButtonStyle.Success).setEmoji('💰')
                );
                return interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
            }

            if (interaction.commandName === 'painel') {
                const embed = new EmbedBuilder().setTitle(config.panelTitle).setDescription(config.panelDescription).setColor(0x3498DB);
                if (config.panelThumb?.startsWith('http')) embed.setThumbnail(config.panelThumb);
                const menu = new StringSelectMenuBuilder().setCustomId('ticket_select').setPlaceholder('📋 Selecione uma categoria...').addOptions(
                    { label: 'Dúvidas Gerais', value: 'duvidas', emoji: '❓' },
                    { label: 'Denúncias / Grif', value: 'grif', emoji: '🍓' },
                    { label: 'Outros Assuntos', value: 'outros', emoji: '🔒' }
                );
                await interaction.reply({ content: 'Painel enviado!', ephemeral: true });
                return interaction.channel.send({ embeds: [embed], components: [new ActionRowBuilder().addComponents(menu)] });
            }

            if (interaction.commandName === 'painelpx') {
                const valor = interaction.options.getString('valor') || 'A combinar';
                const desc = interaction.options.getString('descricao');
                const embed = new EmbedBuilder().setTitle('🐍 Adquirir Hydra / PIX').setColor(0x3498DB).addFields(
                    { name: '🔑 Chave Pix', value: `\`${config.pixKey}\`` },
                    { name: '👤 Beneficiário', value: config.pixName, inline: true },
                    { name: '💰 Valor', value: valor, inline: true }
                ).setFooter({ text: 'Após o pagamento, abra um ticket e envie o comprovante.' });
                if (desc) embed.setDescription(desc);
                return interaction.reply({ embeds: [embed], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('copy_pix').setLabel('Copiar Chave Pix').setStyle(ButtonStyle.Primary).setEmoji('📋'))] });
            }
        }

        if (interaction.isButton()) {
            if (interaction.customId === 'script_redeem') {
                const modal = new ModalBuilder().setCustomId('modal_redeem').setTitle('Redeem Key').addComponents(
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('redeem_key').setLabel('Cole sua Key').setPlaceholder('HYDRA-XXXXXXXXXXXX').setStyle(TextInputStyle.Short).setRequired(true))
                );
                return interaction.showModal(modal);
            }
            if (interaction.customId === 'script_view') {
                const owned = getKeysForUser(interaction.user.id).find(key => !key.revoked && statusOf(key) === 'Em uso');
                if (!owned) return interaction.reply({ content: '❌ Você não possui uma Key ativa. Use **Redeem Key** primeiro.', ephemeral: true });
                const scriptMessage = `📜 **Seu script Hydra**\n\n${formatKeyScript(owned.key)}`;
                return interaction.reply({ content: scriptMessage, ephemeral: true });
            }
            if (interaction.customId === 'script_info') {
                const owned = getKeysForUser(interaction.user.id);
                if (!owned.length) return interaction.reply({ content: '❌ Você ainda não possui uma Key vinculada.', ephemeral: true });
                const lines = owned.map(key => `\`${key.key}\` — **${statusOf(key)}** — ${key.expiresAt ? liveTime(key.expiresAt) : 'Permanente'}`).join('\n');
                return interaction.reply({ embeds: [new EmbedBuilder().setTitle('📊 Key Info').setColor(0x3498DB).setDescription(lines)], ephemeral: true });
            }
            if (interaction.customId === 'script_role') {
                if (!config.buyerRoleId) return interaction.reply({ content: '❌ O cargo de comprador ainda não foi configurado.', ephemeral: true });
                const owned = getKeysForUser(interaction.user.id).find(key => !key.revoked && statusOf(key) === 'Em uso');
                if (!owned) return interaction.reply({ content: '❌ Você precisa resgatar uma Key ativa primeiro.', ephemeral: true });
                const role = interaction.guild.roles.cache.get(config.buyerRoleId);
                if (!role) return interaction.reply({ content: '❌ O cargo configurado não existe mais.', ephemeral: true });
                await interaction.member.roles.add(role);
                return interaction.reply({ content: `✅ Você recebeu o cargo ${role}.`, ephemeral: true });
            }
            if (interaction.customId === 'script_free') {
                const existing = getKeysForUser(interaction.user.id).find(key => !key.revoked && statusOf(key) === 'Em uso');
                if (existing) return interaction.reply({ content: '❌ Você já possui uma Key ativa.', ephemeral: true });
                const freeKey = keys.find(key => !key.revoked && !key.userId && statusOf(key) === 'Disponível');
                if (!freeKey) return interaction.reply({ content: '❌ Não há Keys gratuitas disponíveis no momento.', ephemeral: true });
                freeKey.userId = interaction.user.id;
                freeKey.userTag = interaction.user.tag;
                freeKey.activatedAt = new Date().toISOString();
                freeKey.hwid = null;
                saveKeys();
                await updateStatsMessage();
                const content = `✅ Sua Key gratuita foi ativada.\n\n${formatKeyScript(freeKey.key)}`;
                try { await interaction.user.send(content); } catch (_) {}
                return interaction.reply({ content: '✅ Key gratuita ativada. Confira sua mensagem privada.', ephemeral: true });
            }
            if (interaction.customId === 'script_reset_hwid') {
                const key = getKeysForUser(interaction.user.id).find(item => !item.revoked && statusOf(item) !== 'Expirada');
                if (!key) return interaction.reply({ content: '❌ Você não possui uma Key ativa vinculada à sua conta.', ephemeral: true });
                key.hwid = null;
                key.hwidResetAt = new Date().toISOString();
                key.lastValidatedAt = null;
                saveKeys();
                return interaction.reply({ content: `✅ HWID resetado para a Key **${key.key}**. Execute o script novamente para vincular o novo dispositivo.`, ephemeral: true });
            }

            if (interaction.customId === 'conf_tickets') {
                const modal = new ModalBuilder().setCustomId('modal_tickets').setTitle('Canais e Cargos').addComponents(
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('cat_id').setLabel('ID da Categoria').setStyle(TextInputStyle.Short).setValue(config.ticketCategory || '').setRequired(false)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('staff_id').setLabel('ID do Cargo Staff').setStyle(TextInputStyle.Short).setValue(config.staffRole || '').setRequired(false)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('log_id').setLabel('ID do Canal de Logs').setStyle(TextInputStyle.Short).setValue(config.logChannel || '').setRequired(false))
                );
                return interaction.showModal(modal);
            }
            if (interaction.customId === 'conf_desc') {
                const modal = new ModalBuilder().setCustomId('modal_desc').setTitle('Personalizar Painel').addComponents(
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('p_title').setLabel('Título do Painel').setStyle(TextInputStyle.Short).setValue(config.panelTitle || '')),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('p_desc').setLabel('Descrição do Painel').setStyle(TextInputStyle.Paragraph).setValue(config.panelDescription || '')),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('p_thumb').setLabel('URL da Thumbnail').setStyle(TextInputStyle.Short).setValue(config.panelThumb || '').setRequired(false))
                );
                return interaction.showModal(modal);
            }
            if (interaction.customId === 'conf_pix') {
                const modal = new ModalBuilder().setCustomId('modal_pix').setTitle('Configurar Pix').addComponents(
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('pix_key').setLabel('Chave Pix').setStyle(TextInputStyle.Short).setValue(config.pixKey || '')),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('pix_name').setLabel('Nome').setStyle(TextInputStyle.Short).setValue(config.pixName || ''))
                );
                return interaction.showModal(modal);
            }
            if (interaction.customId === 'close_ticket') {
                await interaction.reply('🔒 Este ticket será encerrado em 5 segundos...');
                return setTimeout(() => interaction.channel.delete().catch(() => {}), 5000);
            }
            if (interaction.customId === 'copy_pix') return interaction.reply({ content: config.pixKey, ephemeral: true });
        }

        if (interaction.isModalSubmit()) {
            if (interaction.customId === 'modal_redeem') {
                const submitted = interaction.fields.getTextInputValue('redeem_key').trim().toUpperCase();
                const key = keys.find(item => item.key === submitted);
                if (!key || key.revoked || statusOf(key) === 'Expirada') return interaction.reply({ content: '❌ Key inválida, expirada ou revogada.', ephemeral: true });
                if (key.userId && key.userId !== interaction.user.id) return interaction.reply({ content: '❌ Esta Key já está vinculada a outro usuário.', ephemeral: true });
                key.userId = interaction.user.id;
                key.userTag = interaction.user.tag;
                key.activatedAt = key.activatedAt || new Date().toISOString();
                key.hwid = null;
                key.roleRemovedAt = null;
                if (config.buyerRoleId && interaction.guild) {
                    const role = interaction.guild.roles.cache.get(config.buyerRoleId);
                    if (role) await interaction.member.roles.add(role, 'Key Hydra resgatada').catch(() => {});
                }
                saveKeys();
                await updateStatsMessage();
                const content = `✅ Key resgatada com sucesso.\nValidade: ${key.expiresAt ? liveTime(key.expiresAt) : 'Permanente'}\n\n${formatKeyScript(key.key)}`;
                try { await interaction.user.send(content); } catch (_) {}
                return interaction.reply({ content: '✅ Key resgatada. O script foi enviado para sua mensagem privada.', ephemeral: true });
            }
            if (interaction.customId === 'modal_reset_hwid') {
                const submitted = interaction.fields.getTextInputValue('reset_key').trim().toUpperCase();
                const key = keys.find(item => item.key === submitted && item.userId === interaction.user.id);
                if (!key || key.revoked || statusOf(key) === 'Expirada') return interaction.reply({ content: '❌ Key inválida, expirada ou não vinculada à sua conta.', ephemeral: true });
                key.hwid = null;
                key.hwidResetAt = new Date().toISOString();
                key.lastValidatedAt = null;
                saveKeys();
                return interaction.reply({ content: '✅ HWID resetado. Execute o script novamente para vincular o novo dispositivo.', ephemeral: true });
            }
            if (interaction.customId === 'modal_tickets') {
                config.ticketCategory = interaction.fields.getTextInputValue('cat_id');
                config.staffRole = interaction.fields.getTextInputValue('staff_id');
                config.logChannel = interaction.fields.getTextInputValue('log_id');
                saveConfig();
                return interaction.reply({ content: '✅ Configurações de canais salvas!', ephemeral: true });
            }
            if (interaction.customId === 'modal_desc') {
                config.panelTitle = interaction.fields.getTextInputValue('p_title');
                config.panelDescription = interaction.fields.getTextInputValue('p_desc');
                config.panelThumb = interaction.fields.getTextInputValue('p_thumb');
                saveConfig();
                return interaction.reply({ content: '✅ Texto e imagem atualizados!', ephemeral: true });
            }
            if (interaction.customId === 'modal_pix') {
                config.pixKey = interaction.fields.getTextInputValue('pix_key');
                config.pixName = interaction.fields.getTextInputValue('pix_name');
                saveConfig();
                return interaction.reply({ content: '✅ Dados do Pix atualizados!', ephemeral: true });
            }
        }

        if (interaction.isStringSelectMenu() && interaction.customId === 'ticket_select') {
            const type = interaction.values[0];
            const user = interaction.user;
            const channelName = `ticket-${user.username.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 80)}`;
            const existing = interaction.guild.channels.cache.find(c => c.name === channelName);
            if (existing) return interaction.reply({ content: `Você já possui um atendimento aberto: ${existing}`, ephemeral: true });
            const channel = await interaction.guild.channels.create({
                name: channelName,
                type: ChannelType.GuildText,
                parent: config.ticketCategory || null,
                permissionOverwrites: [
                    { id: interaction.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
                    { id: user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
                    ...(config.staffRole ? [{ id: config.staffRole, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] }] : [])
                ]
            });
            const embed = new EmbedBuilder().setTitle('🎫 Novo Atendimento').setDescription(`Olá ${user}! Você abriu um ticket para: **${type.toUpperCase()}**.\nDescreva sua dúvida ou problema e aguarde o suporte.`).setColor(0x3498DB).setFooter({ text: 'Use o botão abaixo para encerrar o atendimento' });
            await channel.send({ content: config.staffRole ? `${user} | <@&${config.staffRole}>` : `${user}`, embeds: [embed], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('close_ticket').setLabel('Fechar Ticket').setStyle(ButtonStyle.Danger).setEmoji('🔒'))] });
            await interaction.reply({ content: `✅ Seu ticket foi criado: ${channel}`, ephemeral: true });
            if (config.logChannel) {
                const log = interaction.guild.channels.cache.get(config.logChannel);
                if (log) await log.send(`📂 **Ticket Criado:** ${user.tag} (${user.id}) abriu um ticket de **${type}**.`).catch(() => {});
            }
        }
    } catch (error) {
        console.error('Erro na interação:', error);
        if (!interaction.replied && !interaction.deferred) await interaction.reply({ content: '❌ Ocorreu um erro ao processar esta ação.', ephemeral: true }).catch(() => {});
    }
});

startLicenseApi();
client.login(DISCORD_TOKEN);
