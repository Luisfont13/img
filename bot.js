
require('dotenv').config();
const { Client, GatewayIntentBits, Partials, REST, Routes, PermissionsBitField } = require('discord.js');
const admin = require('firebase-admin');

// --- START: MODIFIED FIREBASE INITIALIZATION ---

// We will no longer use serviceAccountKey.json.
// Instead, we will use environment variables which are better for services like Render.
function initializeFirebase() {
    if (!admin.apps.length) {
        try {
            // --- START: DEBUGGING LOGS ---
            // Let's log the environment variables that the bot can see.
            // This will help us confirm they are set correctly in the hosting service.
            console.log("--- Checking Environment Variables ---");
            console.log("FIREBASE_DATABASE_URL:", process.env.FIREBASE_DATABASE_URL ? "Found" : "Not Found!");
            console.log("FIREBASE_DATABASE_SECRET:", process.env.FIREBASE_DATABASE_SECRET ? "Found" : "Not Found!");
            console.log("DISCORD_BOT_TOKEN:", process.env.DISCORD_BOT_TOKEN ? "Found" : "Not Found!");
            console.log("DISCORD_CLIENT_ID:", process.env.DISCORD_CLIENT_ID ? "Found" : "Not Found!");
            console.log("DISCORD_GUILD_ID:", process.env.DISCORD_GUILD_ID ? "Found" : "Not Found!");
            console.log("------------------------------------");
            // --- END: DEBUGGING LOGS ---


            // Check if the required environment variables are set.
            // You will get these from your Firebase project settings.
            if (!process.env.FIREBASE_DATABASE_URL || !process.env.FIREBASE_DATABASE_SECRET) {
                console.error("Error: FIREBASE_DATABASE_URL and FIREBASE_DATABASE_SECRET environment variables must be set.");
                console.error("Get the Database URL from your Realtime Database page.");
                console.error("Get the Database Secret from Project Settings > Service Accounts > Database secrets.");
                process.exit(1);
            }

            admin.initializeApp({
                databaseURL: process.env.FIREBASE_DATABASE_URL,
                databaseAuthVariableOverride: {
                    // This tells Firebase we are authenticating with a secret.
                    // The bot will now have full admin access to the database.
                    uid: 'discord-bot-service' 
                }
            });
            console.log('Firebase Admin SDK initialized successfully using Database Secret.');
        } catch (error) {
            console.error('Error initializing Firebase Admin in the bot:', error.stack);
            process.exit(1);
        }
    }
    // The old db.auth() method is deprecated and was causing a crash.
    // The modern SDK handles authentication with the database secret
    // through the `databaseAuthVariableOverride` parameter during initializeApp.
    // We can just return the database instance now.
    return admin.database();
}
// --- END: MODIFIED FIREBASE INITIALIZATION ---


function initializeBot() {
    console.log('Initializing Discord bot...');

    // --- START: Get config from environment variables ---
    const token = process.env.DISCORD_BOT_TOKEN;
    const clientId = process.env.DISCORD_CLIENT_ID;
    const guildId = process.env.DISCORD_GUILD_ID;

    if (!token || !clientId || !guildId) {
        console.error("Error: DISCORD_BOT_TOKEN, DISCORD_CLIENT_ID, and DISCORD_GUILD_ID must be set in environment variables.");
        process.exit(1);
    }
    // --- END: Get config from environment variables ---

    const db = initializeFirebase();

    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.GuildMembers,
        ],
        partials: [Partials.Channel],
    });

    const commands = [
        {
            name: 'ping',
            description: 'Replies with Pong!',
        },
        {
            name: 'balance',
            description: 'Check your or another user\'s coin balance.',
            options: [
                {
                    name: 'user',
                    type: 6, // USER type
                    description: 'The user whose balance you want to see.',
                    required: false,
                },
            ],
        },
        {
            name: 'pay',
            description: 'Transfer coins to another user.',
            options: [
                {
                    name: 'user',
                    type: 6, // USER type
                    description: 'The user you want to pay.',
                    required: true,
                },
                {
                    name: 'amount',
                    type: 4, // INTEGER type
                    description: 'The amount of coins to pay.',
                    required: true,
                }
            ]
        },
        {
            name: 'add-money',
            description: 'Add coins to a user. (Admin only)',
            options: [
                {
                    name: 'user',
                    type: 6,
                    description: 'The user to add coins to.',
                    required: true,
                },
                {
                    name: 'amount',
                    type: 4,
                    description: 'The amount of coins to add.',
                    required: true,
                }
            ],
            default_member_permissions: String(PermissionsBitField.Flags.Administrator),
        },
        {
            name: 'remove-money',
            description: 'Remove coins from a user. (Admin only)',
            options: [
                {
                    name: 'user',
                    type: 6,
                    description: 'The user to remove coins from.',
                    required: true,
                },
                {
                    name: 'amount',
                    type: 4,
                    description: 'The amount of coins to remove.',
                    required: true,
                }
            ],
            default_member_permissions: String(PermissionsBitField.Flags.Administrator),
        },
    ];

    client.once('ready', async () => {
        console.log(`Bot is ready! Logged in as ${client.user.tag}`);

        const rest = new REST({ version: '10' }).setToken(token);

        try {
            console.log('Started refreshing application (/) commands for the guild.');
            await rest.put(
                Routes.applicationGuildCommands(clientId, guildId),
                { body: commands },
            );
            console.log('Successfully reloaded application (/) commands for the guild.');
        } catch (error) {
            console.error("Error registering guild commands:", error);
        }
    });

    client.on('interactionCreate', async interaction => {
        if (!interaction.isCommand()) return;

        const { commandName, options } = interaction;
        const userRef = (userId) => db.ref(`users/${userId}/coins`);

        if (commandName === 'ping') {
            await interaction.reply({ content: 'Pong! 🏓', ephemeral: true });
        } else if (commandName === 'balance') {
            const user = options.getUser('user') || interaction.user;
            const snapshot = await userRef(user.id).once('value');
            const balance = snapshot.val() || 0;
            await interaction.reply(`💰 The balance of **${user.username}** is **${balance.toLocaleString()}** coins.`);
        } else if (commandName === 'pay') {
            const targetUser = options.getUser('user');
            const amount = options.getInteger('amount');

            if (amount <= 0) return interaction.reply({ content: 'Please provide a valid amount greater than zero.', ephemeral: true });
            if (targetUser.id === interaction.user.id) return interaction.reply({ content: 'You cannot pay yourself.', ephemeral: true });
            if (targetUser.bot) return interaction.reply({ content: 'You cannot pay a bot.', ephemeral: true });

            const authorId = interaction.user.id;
            const targetId = targetUser.id;

            try {
                const authorRef = userRef(authorId);
                const targetRef = userRef(targetId);

                const authorSnapshot = await authorRef.once('value');
                const authorBalance = authorSnapshot.val() || 0;

                if (authorBalance < amount) {
                    return interaction.reply({ content: `You don't have enough coins to complete this transaction.`, ephemeral: true });
                }

                await authorRef.set(authorBalance - amount);

                const targetSnapshot = await targetRef.once('value');
                const targetBalance = targetSnapshot.val() || 0;
                await targetRef.set(targetBalance + amount);

                await interaction.reply(`💸 Success! You have sent **${amount.toLocaleString()}** coins to **${targetUser.username}**.`);
            } catch (error) {
                console.error("Payment transaction failed: ", error);
                await interaction.reply({ content: 'An error occurred while processing the payment.', ephemeral: true });
            }
        } else if (commandName === 'add-money' || commandName === 'remove-money') {
            if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
                return interaction.reply({ content: '❌ You do not have permission to use this command.', ephemeral: true });
            }

            const targetUser = options.getUser('user');
            const amount = options.getInteger('amount');

            if (amount <= 0) return interaction.reply({ content: 'Please provide a valid amount.', ephemeral: true });
            if (targetUser.bot) return interaction.reply({ content: 'You cannot modify a bot\'s balance.', ephemeral: true });

            const targetRef = userRef(targetUser.id);

            try {
                const { committed, snapshot } = await targetRef.transaction((currentBalance) => {
                    currentBalance = currentBalance || 0;
                    if (commandName === 'add-money') {
                        return currentBalance + amount;
                    } else { // remove-money
                        if (currentBalance < amount) {
                            return; // Abort transaction
                        }
                        return currentBalance - amount;
                    }
                });

                if (committed) {
                    const newBalance = snapshot.val();
                    const actionText = commandName === 'add-money' ? 'Added' : 'Removed';
                    await interaction.reply(`✅ ${actionText} **${amount.toLocaleString()}** coins to/from **${targetUser.username}**. New balance: **${newBalance.toLocaleString()}**.`);
                } else {
                    await interaction.reply({ content: `The user only has ${snapshot.val() || 0} coins. You cannot remove more than what they have.`, ephemeral: true });
                }
            } catch (error) {
                console.error("Admin money command failed:", error);
                await interaction.reply({ content: 'An error occurred while updating the balance.', ephemeral: true });
            }
        }
    });

    client.login(token).catch(err => {
        console.error('Error logging in the bot:', err);
    });

    return client;
}

// Start the bot directly
initializeBot();
