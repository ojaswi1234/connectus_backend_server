import { createServer } from "http";
import { createSchema, createYoga, createPubSub } from "graphql-yoga";
import { WebSocketServer } from 'ws';
import { useServer } from 'graphql-ws/use/ws';

const pubSub = createPubSub();
// This is your "Database" (In-Memory). 
// Messages stay here as long as the server runs.
const messages = []; 

const yoga = createYoga({
  schema: createSchema({
    typeDefs: /* GraphQL */ `
      type Message {
        id: ID!
        roomId: String!  # Logic to separate chats
        user: String!
        content: String!
        createdAt: String!
      }

      type Query {
        # Fetch history for a specific room only
        messages(roomId: String!): [Message!]!
      }

      type Mutation {
        postMessage(roomId: String!, user: String!, content: String!): Message!
      }

      type Subscription {
        # Listen for updates in a specific room
        messageAdded(roomId: String!): Message!
      }
    `,
    resolvers: {
      Query: {
        // Filter the global list to return only this room's messages
        messages: (_, { roomId }) => messages.filter(m => m.roomId === roomId),
      },
      Mutation: {
        postMessage: (_, { roomId, user, content }) => {
          const newMessage = {
            id: String(messages.length),
            roomId,
            user,
            content,
            createdAt: new Date().toISOString(),
          };
          messages.push(newMessage);
          
          // Publish ONLY to people listening to this roomId
          pubSub.publish(`MESSAGE_ADDED_${roomId}`, { messageAdded: newMessage });
          
          return newMessage;
        },
      },
      Subscription: {
        messageAdded: {
          // Subscribe ONLY to the specific room channel
          subscribe: (_, { roomId }) => pubSub.subscribe(`MESSAGE_ADDED_${roomId}`),
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
      const { schema, execute, subscribe, contextFactory, parse, validate } =
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