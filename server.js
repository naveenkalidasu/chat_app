const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const mongoose = require('mongoose');
const axios = require('axios');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// MongoDB Connection
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://naveenkalidasu_db_user:PMJK36th3QfTesXc@cluster0.0ndmeb3.mongodb.net/chatapp';
mongoose.connect(MONGODB_URI)
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('MongoDB connection error:', err));

// MongoDB Schema
const messageSchema = new mongoose.Schema({
  id: String,
  msg: String,
  username: String,
  userId: String,
  timestamp: Date,
  status: String,
  seenBy: [String],
  isAIGenerated: Boolean
});

// Training data schema for Tinglish suggestions
const trainingSchema = new mongoose.Schema({
  original: String,
  corrected: String,
  username: String,
  timestamp: Date,
  usageCount: { type: Number, default: 1 }
});

const Message = mongoose.model('Message', messageSchema);
const TrainingData = mongoose.model('TrainingData', trainingSchema);

// Mistral AI Configuration
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY || 'Zm68RHJ8zX6nKST0a1P7sAE4Ii3luIY2';
const MISTRAL_API_URL = 'https://api.mistral.ai/v1/chat/completions';

let users = {};
let typingTimeout = {};

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.get('/', (req, res) => {
    res.render('index');
});

app.post('/chat', (req, res) => {
    const username = req.body.username;
    res.render('chat', { username });
});

// Training data for Tinglish suggestions (pre-loaded common patterns)
const commonTinglishPatterns = {
  'namaskaram': 'Namaskaram (Hello)',
  'ela unnaru': 'Elā unnāru? (How are you?)',
  'bagunnara': 'Bagunnārā? (Are you doing well?)',
  'bagundi': 'Bagundi (It\'s good)',
  'baga ledu': 'Bagā lēdu (Not very good)',
  'em chesaru': 'Ēmi chesāru? (What did you do?)',
  'em jarigindi': 'Ēmi jarigindi? (What happened?)',
  'em kavali': 'Ēmi kāvāli? (What do you want?)',
  'naa peru': 'Nā pēru (My name)',
  'meeru evaru': 'Mīru evaru? (Who are you?)',
  'sare': 'Sare (Okay)',
  'sarele': 'Sarele (Okay then)',
  'anthe': 'Ante (That\'s it)',
  'anthega': 'Antega? (Is that so?)',
  'nijamga': 'Nijamga? (Really?)',
  'ippudu': 'Ippudu (Now)',
  'taruvata': 'Taruvāta (Later)',
  'repu': 'Repu (Tomorrow)',
  'ninna': 'Ninna (Yesterday)',
  'bavundi': 'Bāvundi (It\'s good)',
  'bava ledu': 'Bāvā lēdu (Not good)',
  'baagundi': 'Bāgundi (It\'s good)',
  'nachindi': 'Nāchindi (I liked it)',
  'tinna': 'Tinna? (Did you eat?)',
  'tinna ledu': 'Tinna lēdu (Not eaten yet)',
  'tiffin': 'Tiffin (Breakfast/Snack)',
  'kali': 'Kali (Hungry)',
  'nidra': 'Nidra (Sleep)'
};

// AI Grammar Correction with Tinglish support
async function checkGrammar(text) {
    try {
        const isTinglish = /[a-zA-Z\s]+/.test(text) && /[aeiou]/i.test(text) && 
                          text.split(' ').length <= 10;
        
        let systemPrompt = "You are a grammar checker. Check the grammar of the following text and return ONLY the corrected version.";
        
        if (isTinglish) {
            systemPrompt = `You are a grammar checker that understands Telugu-English (Tinglish). 
Correct the grammar and spelling of the following Telugu-English mixed text.
Return ONLY the corrected version with proper Telugu words mixed with English.
Return ONLY the corrected text with proper Telugu script or transliteration.`;
        }

        const response = await axios.post(MISTRAL_API_URL, {
            model: "mistral-tiny",
            messages: [
                {
                    role: "system",
                    content: systemPrompt
                },
                {
                    role: "user",
                    content: text
                }
            ],
            temperature: 0.3,
            max_tokens: 150
        }, {
            headers: {
                'Authorization': `Bearer ${MISTRAL_API_KEY}`,
                'Content-Type': 'application/json'
            }
        });
        
        let corrected = response.data.choices[0].message.content.trim();
        corrected = corrected.replace(/^["']|["']$/g, '');
        
        try {
            await TrainingData.findOneAndUpdate(
                { original: text.toLowerCase() },
                { 
                    $set: { 
                        original: text.toLowerCase(),
                        corrected: corrected,
                        timestamp: new Date()
                    },
                    $inc: { usageCount: 1 }
                },
                { upsert: true, new: true }
            );
        } catch (error) {
            console.error('Error saving training data:', error);
        }
        
        return corrected;
    } catch (error) {
        console.error('Grammar check error:', error);
        return text;
    }
}

// Get Tinglish auto-suggestions from training data
async function getTinglishSuggestions(input) {
    try {
        const inputLower = input.toLowerCase().trim();
        
        const trainingSuggestions = await TrainingData.find({
            original: { $regex: inputLower, $options: 'i' }
        }).sort({ usageCount: -1 }).limit(5);
        
        let suggestions = trainingSuggestions.map(item => item.original);
        
        if (suggestions.length < 5) {
            const patternMatches = Object.keys(commonTinglishPatterns)
                .filter(pattern => pattern.includes(inputLower) || inputLower.includes(pattern))
                .slice(0, 5 - suggestions.length);
            
            suggestions = [...suggestions, ...patternMatches];
        }
        
        if (suggestions.length < 3) {
            try {
                const response = await axios.post(MISTRAL_API_URL, {
                    model: "mistral-tiny",
                    messages: [
                        {
                            role: "system",
                            content: `Generate 3 Telugu-English (Tinglish) phrases that start with or contain: "${input}". 
Return as JSON array of strings.`
                        },
                        {
                            role: "user",
                            content: `Generate Tinglish phrases containing: ${input}`
                        }
                    ],
                    temperature: 0.7,
                    max_tokens: 100
                }, {
                    headers: {
                        'Authorization': `Bearer ${MISTRAL_API_KEY}`,
                        'Content-Type': 'application/json'
                    }
                });
                
                let aiSuggestions = response.data.choices[0].message.content.trim();
                try {
                    aiSuggestions = JSON.parse(aiSuggestions);
                    if (Array.isArray(aiSuggestions)) {
                        suggestions = [...suggestions, ...aiSuggestions];
                    }
                } catch {
                    const matches = aiSuggestions.match(/"([^"]*)"/g);
                    if (matches) {
                        const parsed = matches.map(m => m.replace(/"/g, ''));
                        suggestions = [...suggestions, ...parsed];
                    }
                }
            } catch (error) {
                console.error('AI suggestion generation error:', error);
            }
        }
        
        suggestions = [...new Set(suggestions)].slice(0, 8);
        
        return suggestions.map(s => {
            const meaning = commonTinglishPatterns[s.toLowerCase()] || '';
            return {
                text: s,
                meaning: meaning,
                isPattern: !!commonTinglishPatterns[s.toLowerCase()]
            };
        });
    } catch (error) {
        console.error('Error getting suggestions:', error);
        return [];
    }
}

// Train AI from chat history - FIXED VERSION WITHOUT BROKEN REGEX
async function trainFromHistory() {
    try {
        const recentMessages = await Message.find({ 
            isAIGenerated: true 
        }).sort({ timestamp: -1 }).limit(50);
        
        for (const msg of recentMessages) {
<<<<<<< HEAD
            // Extract original and corrected versions - using simple string methods
=======
>>>>>>> 5b440f8ebfe27589e418bce761afc92a96f6bfa6
            let original = '';
            let corrected = '';
            
            if (msg.msg.includes('→')) {
                const parts = msg.msg.split('→');
                original = parts[0].trim();
                corrected = parts[1].trim();
            } else if (msg.msg.includes('->')) {
                const parts = msg.msg.split('->');
                original = parts[0].trim();
                corrected = parts[1].trim();
            } else if (msg.msg.includes('=>')) {
                const parts = msg.msg.split('=>');
                original = parts[0].trim();
                corrected = parts[1].trim();
            }
            
            if (original && corrected) {
                await TrainingData.findOneAndUpdate(
                    { original: original.toLowerCase() },
                    { 
                        $set: { 
                            original: original.toLowerCase(),
                            corrected: corrected,
                            timestamp: new Date()
                        },
                        $inc: { usageCount: 1 }
                    },
                    { upsert: true, new: true }
                );
            }
        }
        console.log('Training completed from chat history');
    } catch (error) {
        console.error('Training error:', error);
    }
}

// Train on startup
trainFromHistory();

io.on('connection', (socket) => {
    console.log('New client connected:', socket.id);

    socket.on('join', async (username) => {
        users[socket.id] = { username, id: socket.id };
        socket.broadcast.emit('userJoined', username);
        io.emit('updateUserCount', Object.keys(users).length);
        
        try {
            const messages = await Message.find().sort({ timestamp: -1 }).limit(100);
            socket.emit('messageHistory', messages.reverse());
        } catch (error) {
            console.error('Error loading messages:', error);
            socket.emit('messageHistory', []);
        }
        
        socket.broadcast.emit('userTyping', { 
            username, 
            isTyping: false,
            userId: socket.id 
        });
    });

    socket.on('chatMessage', async (msg) => {
        const user = users[socket.id];
        if (!user) return;

        let finalMsg = msg;
        let isAIGenerated = false;

        if (msg.startsWith('/correct ') || msg.startsWith('/grammar ')) {
            const textToCheck = msg.includes('/correct ') ? msg.substring(9) : msg.substring(9);
            finalMsg = await checkGrammar(textToCheck);
            isAIGenerated = true;
        }

        const messageData = {
            id: Date.now().toString(),
            msg: finalMsg,
            username: user.username,
            userId: socket.id,
            timestamp: new Date(),
            status: 'sent',
            seenBy: [],
            isAIGenerated: isAIGenerated
        };

        try {
            const messageDoc = new Message(messageData);
            await messageDoc.save();
            
            if (isAIGenerated && msg.includes('/correct ')) {
                const original = msg.substring(9);
                await TrainingData.findOneAndUpdate(
                    { original: original.toLowerCase() },
                    { 
                        $set: { 
                            original: original.toLowerCase(),
                            corrected: finalMsg,
                            username: user.username,
                            timestamp: new Date()
                        },
                        $inc: { usageCount: 1 }
                    },
                    { upsert: true, new: true }
                );
            }
        } catch (error) {
            console.error('Error saving message:', error);
        }
        
        io.emit('chatMessage', messageData);
        
        setTimeout(() => {
            const otherUsers = Object.keys(users).filter(id => id !== socket.id);
            if (otherUsers.length > 0) {
                messageData.status = 'delivered';
                io.emit('messageStatusUpdate', { 
                    messageId: messageData.id, 
                    status: 'delivered',
                    seenBy: []
                });
            }
        }, 500);
    });

    socket.on('getSuggestions', async (input) => {
        if (input.length < 2) {
            socket.emit('suggestions', []);
            return;
        }
        
        const suggestions = await getTinglishSuggestions(input);
        socket.emit('suggestions', suggestions);
    });

    socket.on('typing', (isTyping) => {
        const username = users[socket.id]?.username;
        if (username) {
            if (typingTimeout[socket.id]) {
                clearTimeout(typingTimeout[socket.id]);
            }
            
            if (isTyping) {
                socket.broadcast.emit('userTyping', { 
                    username, 
                    isTyping: true,
                    userId: socket.id 
                });
                
                typingTimeout[socket.id] = setTimeout(() => {
                    socket.broadcast.emit('userTyping', { 
                        username, 
                        isTyping: false,
                        userId: socket.id 
                    });
                }, 3000);
            } else {
                socket.broadcast.emit('userTyping', { 
                    username, 
                    isTyping: false,
                    userId: socket.id 
                });
            }
        }
    });

    socket.on('messageSeen', async (messageId) => {
        try {
            const message = await Message.findOne({ id: messageId });
            if (message && !message.seenBy.includes(socket.id)) {
                message.seenBy.push(socket.id);
                await message.save();
                
                const otherUsers = Object.keys(users).filter(id => id !== message.userId);
                if (message.seenBy.length >= otherUsers.length) {
                    message.status = 'seen';
                    await message.save();
                    io.emit('messageStatusUpdate', { 
                        messageId: message.id, 
                        status: 'seen',
                        seenBy: message.seenBy
                    });
                } else {
                    io.emit('messageStatusUpdate', { 
                        messageId: message.id, 
                        status: 'delivered',
                        seenBy: message.seenBy
                    });
                }
            }
        } catch (error) {
            console.error('Error updating message status:', error);
        }
    });

    socket.on('disconnect', () => {
        const user = users[socket.id];
        if (user) {
            const username = user.username;
            delete users[socket.id];
            socket.broadcast.emit('userLeft', username);
            io.emit('updateUserCount', Object.keys(users).length);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
    console.log('AI Training initialized with Tinglish support');
});
