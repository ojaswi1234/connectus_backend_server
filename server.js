import { createServer } from "http";
import { createSchema, createYoga, createPubSub } from "graphql-yoga";
import { WebSocketServer } from 'ws';
import { useServer } from 'graphql-ws/use/ws';
// 1. Import Crypto for encryption
import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';

const pubSub = createPubSub();
const messages = []; 

// --- ENCRYPTION SETUP ---
// We generate a fresh key every time the server starts. 
// Since your DB is in-memory, this is perfect (key dies with the data).
const algorithm = 'aes-256-cbc';
const secretKey = randomBytes(32); 
const ivLength = 16;

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
        type UserChat {
        room_id: String!
        contact_name: String!
        last_message: String!
        created_at: String!
      }

      type Query {
        messages(roomId: String!): [Message!]!
        user_chats_view(user: String!): [UserChat!]!
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
          // 2. Decrypt messages on-the-fly when requested
          return messages
            .filter(m => m.roomId === roomId)
            .map(m => ({
              ...m,
              content: decrypt(m.content) 
            }));
        },
        user_chats_view: (_, { user }) => {
          // Filter messages where I am the sender OR receiver
          const myMessages = messages.filter(m => m.user === user || m.to === user);
          
          // Group by Room ID to find the latest message
          const rooms = {};
          myMessages.forEach(m => {
            // If room doesn't exist OR this message is newer, replace it
            if (!rooms[m.roomId] || new Date(m.createdAt) > new Date(rooms[m.roomId].createdAt)) {
              rooms[m.roomId] = m;
            }
          });

          // Convert to List and Format
          return Object.values(rooms).map(m => ({
            room_id: m.roomId,
            // If I sent it, the contact is 'to'. If they sent it, contact is 'user'
            contact_name: m.user === user ? m.to : m.user,
            // Decrypt so the list shows readable text
            last_message: decrypt(m.content),
            created_at: m.createdAt
          })).sort((a, b) => new Date(b.created_at) - new Date(a.created_at)); // Sort newest first
        }
      },
      Mutation: {
        postMessage: (_, { roomId, user, to, content }) => {
          // 3. Encrypt content BEFORE storing
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
          
          // 4. Send PLAINTEXT to live subscribers (so they can read it)
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
  console.log(`Server is running on http://localhost:${PORT}/graphql`);
});