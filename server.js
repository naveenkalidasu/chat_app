const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const users = {};
const messages = [];
let messageIdCounter = 0;

app.get('/', (req, res) => {
    res.render('index');
});

app.post('/chat', (req, res) => {
    const { username } = req.body;
    if (!username) return res.redirect('/');
    res.render('chat', { username });
});

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('join', (username) => {
        users[socket.id] = { username, online: true };
        socket.join('group');

        socket.emit('messageHistory', messages);
        io.to('group').emit('updateUserCount', Object.keys(users).length);

        const joinMsg = {
            id: 'join_' + Date.now(),
            msg: `👋 ${username} joined the chat`,
            username: 'System',
            timestamp: new Date(),
            isSystem: true
        };
        messages.push(joinMsg);
        io.to('group').emit('chatMessage', joinMsg);
    });

    socket.on('chatMessage', (data) => {
        const user = users[socket.id];
        if (!user) return;

        const messageData = {
            id: 'msg_' + (++messageIdCounter),
            msg: data.msg,
            username: data.username,
            timestamp: new Date(),
            status: 'sent',
            reaction: null,
            file: data.file || null
        };

        messages.push(messageData);
        io.to('group').emit('chatMessage', messageData);

        setTimeout(() => {
            messageData.status = 'delivered';
            io.to('group').emit('messageStatusUpdate', { 
                messageId: messageData.id, 
                status: 'delivered' 
            });
        }, 1000);

        setTimeout(() => {
            messageData.status = 'seen';
            io.to('group').emit('messageStatusUpdate', { 
                messageId: messageData.id, 
                status: 'seen' 
            });
        }, 3000);
    });

    socket.on('typing', (data) => {
        const user = users[socket.id];
        if (!user) return;
        socket.to('group').emit('userTyping', {
            username: data.username,
            isTyping: data.isTyping
        });
    });

    socket.on('addReaction', (data) => {
        const user = users[socket.id];
        if (!user) return;
        
        const msg = messages.find(m => m.id === data.messageId);
        if (msg) {
            msg.reaction = data.emoji;
            io.to('group').emit('reactionUpdate', {
                messageId: data.messageId,
                emoji: data.emoji,
                emojiUrl: data.emojiUrl,
                username: user.username
            });
        }
    });

    socket.on('disconnect', () => {
        const user = users[socket.id];
        if (user) {
            const username = user.username;
            delete users[socket.id];
            
            io.to('group').emit('updateUserCount', Object.keys(users).length);
            
            const leaveMsg = {
                id: 'leave_' + Date.now(),
                msg: `👋 ${username} left the chat`,
                username: 'System',
                timestamp: new Date(),
                isSystem: true
            };
            messages.push(leaveMsg);
            io.to('group').emit('chatMessage', leaveMsg);
        }
        console.log('User disconnected:', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
});
