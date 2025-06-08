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

// Setup the bot and its webhook
setupBot(app);

app.listen(port, () => {
    console.log(`Server is listening on port ${port}`);
}); 