import { createServer } from "http";
import { createSchema, createYoga, createPubSub } from "graphql-yoga";
import { WebSocketServer } from 'ws';
import { useServer } from 'graphql-ws/use/ws';
// 1. Import Crypto for encryption
import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';
// 2. Import File System and Path for persistence
import fs from 'fs';
import path from 'path';
import 'dotenv/config'; // Load environment variables

const pubSub = createPubSub();

// --- 3. PERSISTENT STORAGE SETUP ---
// We will save messages to a file named 'messages.json' in the same folder as this script
const DATA_FILE = path.join(process.cwd(), 'messages.json');

// Helper to load messages from disk
function loadMessages() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const data = fs.readFileSync(DATA_FILE, 'utf-8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error("Could not load messages:", err);
  }
  return [];
}

// Helper to save messages to disk
function saveMessages(data) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("Could not save messages:", err);
  }
}

// Initialize messages from the file instead of an empty array
const messages = loadMessages(); 
// -----------------------------------

// --- ENCRYPTION SETUP ---
const algorithm = 'aes-256-cbc';
const ivLength = 16;

// 4. Use a persistent key from .env, or fallback to random (data loss risk)
// The key in .env should be a 64-character hex string (32 bytes)
let secretKey;

if (process.env.CHAT_SECRET_KEY) {
  try {
    secretKey = Buffer.from(process.env.CHAT_SECRET_KEY, 'hex');
    if (secretKey.length !== 32) {
      throw new Error("Invalid key length");
    }
  } catch (e) {
    console.error("Error reading CHAT_SECRET_KEY. Falling back to random key (Old messages will be unreadable).");
    secretKey = randomBytes(32);
  }
} else {
  console.warn("WARNING: CHAT_SECRET_KEY not found in .env. Using random key. Messages will be lost on restart.");
  secretKey = randomBytes(32);
}

function encrypt(text) {
  const iv = randomBytes(ivLength);
  const cipher = createCipheriv(algorithm, secretKey, iv);
  let encrypted = cipher.update(text);
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  // Store as "IV:EncryptedData" so we can decrypt later
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decrypt(text) {
  try {
    const textParts = text.split(':');
    const iv = Buffer.from(textParts.shift(), 'hex');
    const encryptedText = Buffer.from(textParts.join(':'), 'hex');
    const decipher = createDecipheriv(algorithm, secretKey, iv);
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString();
  } catch (error) {
    return "[Error: Could not decrypt message]";
  }
}
// ------------------------

const yoga = createYoga({
  schema: createSchema({
    typeDefs: /* GraphQL */ `
      type Message {
        id: ID!
        roomId: String!
        user: String!
        to: String!
        content: String!
        createdAt: String!
      }

      type Query {
        messages(roomId: String!): [Message!]!
      }

      type Mutation {
        postMessage(roomId: String!, user: String!, to: String!, content: String!): Message!
      }

      type Subscription {
        messageAdded(roomId: String!): Message!
        messageSentToUser(user: String!): Message!
      }
    `,
    resolvers: {
      Query: {
        messages: (_, { roomId }) => {
          // Decrypt messages on-the-fly when requested
          return messages
            .filter(m => m.roomId === roomId)
            .map(m => ({
              ...m,
              content: decrypt(m.content) 
            }));
        },
      },
      Mutation: {
        postMessage: (_, { roomId, user, to, content }) => {
          // Encrypt content BEFORE storing
          const encryptedContent = encrypt(content);

          const storedMessage = {
            id: String(messages.length),
            roomId,
            user,
            to,
            content: encryptedContent, // Storing gibberish
            createdAt: new Date().toISOString(),
          };
          
          messages.push(storedMessage);
          
          // 5. Save to disk immediately so we don't lose it on crash/restart
          saveMessages(messages); 
          
          // Send PLAINTEXT to live subscribers (so they can read it immediately)
          const publicMessage = { ...storedMessage, content }; 

          pubSub.publish(`MESSAGE_ADDED_${roomId}`, { messageAdded: publicMessage });
          pubSub.publish(`MESSAGE_TO_${to}`, { messageSentToUser: publicMessage });
          
          return publicMessage;
        },
      },
      Subscription: {
        messageAdded: {
          subscribe: (_, { roomId }) => pubSub.subscribe(`MESSAGE_ADDED_${roomId}`),
        },
        messageSentToUser: {
          subscribe: (_, { user }) => pubSub.subscribe(`MESSAGE_TO_${user}`),
        },
      },
    },
  }),
  graphiql: {
    subscriptionsProtocol: 'WS',
  },
});

const server = createServer(yoga);

const wsServer = new WebSocketServer({
  server,
  path: yoga.graphqlEndpoint,
});

useServer(
  {
    execute: (args) => args.rootValue.execute(args),
    subscribe: (args) => args.rootValue.subscribe(args),
    onSubscribe: async (ctx, msg) => {
      const { schema, execute, subscribe, contextFactory, parse } =
        yoga.getEnveloped({
          ctx,
          req: ctx.extra.request,
          socket: ctx.extra.socket,
          params: msg.payload,
        });

      return {
        schema,
        operationName: msg.payload.operationName,
        document: parse(msg.payload.query),
        variableValues: msg.payload.variables,
        contextValue: await contextFactory(),
        rootValue: { execute, subscribe },
      };
    },
  },
  wsServer
);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Server is running on http://localhost:4000/graphql');
});