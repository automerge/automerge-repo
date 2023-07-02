yarn start & background_pid=$!

# Run the tests
yarn test:run
return_value=$?

kill -SIGTERM $background_pid

exit $return_value
