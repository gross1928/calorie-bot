require('dotenv').config();
const express = require('express');
const { setupBot } = require('./bot');

const app = express();
const port = process.env.PORT || 3000;

// Telegram bot webhook requires a POST route to receive updates
app.use(express.json());

app.get('/', (req, res) => {
    res.send('Calorie Counter Bot is running!');
});

// Setup the bot and its webhook with error handling
try {
    console.log('Starting bot setup...');
    setupBot(app);
    console.log('Bot setup completed successfully');
} catch (error) {
    console.error('Error setting up bot:', error);
    process.exit(1);
}

app.listen(port, () => {
    console.log(`Server is listening on port ${port}`);
}); 