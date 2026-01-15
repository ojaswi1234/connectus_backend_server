import { createServer } from "http";
import { createSchema, createYoga, createPubSub } from "graphql-yoga";
import { WebSocketServer } from 'ws';
import { useServer } from 'graphql-ws/use/ws';

const pubSub = createPubSub();
const messages = [];

const yoga = createYoga({
  schema: createSchema({
    typeDefs: /* GraphQL */ `
      type Message {
        id: ID!
        user: String!
        content: String!
        createdAt: String!
      }

      type Query {
        messages: [Message!]!
      }

      type Mutation {
        # FIXED: Returns the full Message object, not just an ID
        postMessage(user: String!, content: String!): Message!
      }

      type Subscription {
        messageAdded: Message!
      }
    `,
    resolvers: {
      Query: {
        messages: () => messages,
      },
      Mutation: {
        postMessage: (parent, { user, content }) => {
          const newMessage = {
            id: String(messages.length),
            user,
            content,
            createdAt: new Date().toISOString(),
          };
          messages.push(newMessage);
          
          // Publish to subscribers
          pubSub.publish("MESSAGE_ADDED", { messageAdded: newMessage });
          
          // Return the full object to the mutation caller
          return newMessage;
        },
      },
      Subscription: {
        messageAdded: {
          subscribe: () => pubSub.subscribe("MESSAGE_ADDED"),
        },
      },
    },
  }),
  graphiql: {
    subscriptionsProtocol: 'WS', // Forces GraphiQL to use WebSocket for subscriptions
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

      const args = {
        schema,
        operationName: msg.payload.operationName,
        document: parse(msg.payload.query),
        variableValues: msg.payload.variables,
        contextValue: await contextFactory(),
        rootValue: {
          execute,
          subscribe,
        },
      };

      return args;
    },
  },
  wsServer
);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Server is running on http://localhost:4000/graphql');
});