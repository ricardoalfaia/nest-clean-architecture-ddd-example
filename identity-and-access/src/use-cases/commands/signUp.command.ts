import { DomainEventPublisher } from '@common/domain-event-publisher/adapters/domainEventPublisher';
import { PinoLoggerService } from '@common/logger/adapters/pinoLogger.service';
import { executeTask } from '@common/utils/executeTask';
import { fromUnknown } from '@common/utils/fromUnknown';
import { perform } from '@common/utils/perform';
import { DefaultAuthenticationService } from '@identity-and-access/adapters/secondaries/real/defaultAuthentication.service';
import { DefaultUUIDGeneratorService } from '@identity-and-access/adapters/secondaries/real/defaultUUIDGenerator.service';
import { User } from '@identity-and-access/domain/entities/user';
import { UserRepository } from '@identity-and-access/domain/repositories/user.repository';
import { UnverifiedEmail } from '@identity-and-access/domain/value-objects/emailInfos';
import { PlainPassword } from '@identity-and-access/domain/value-objects/password';
import { UUID } from '@identity-and-access/domain/value-objects/uuid';
import { ConflictException } from '@nestjs/common';
import { CommandHandler, ICommand, ICommandHandler } from '@nestjs/cqrs';
import { sequenceS, sequenceT } from 'fp-ts/lib/Apply';
import { pipe } from 'fp-ts/lib/function';
import { chain, left, map, right, taskEither } from 'fp-ts/lib/TaskEither';
import { USER_CREATED } from '../listeners/userEvent.listener';

export class SignUp implements ICommand {
  constructor(public readonly email: string, public readonly password: string) {}
}

@CommandHandler(SignUp)
export class SignUpHandler implements ICommandHandler {
  constructor(
    private readonly uuidGeneratorService: DefaultUUIDGeneratorService,
    private readonly authenticationService: DefaultAuthenticationService,
    private readonly userRepository: UserRepository,
    private readonly domainEventPublisher: DomainEventPublisher,
    private readonly logger: PinoLoggerService,
  ) {
    this.logger.setContext('SignUp');
  }

  execute(command: SignUp): Promise<void> {
    const { email, password } = command;

    const task = pipe(
      //Data validation
      sequenceS(taskEither)({
        id: fromUnknown(this.uuidGeneratorService.generateUUID(), UUID, this.logger, 'uuid'),
        email: fromUnknown(email, UnverifiedEmail, this.logger, 'email'),
        plainPassword: fromUnknown(password, PlainPassword, this.logger, 'plain password'),
      }),
      chain((validatedDatas) =>
        sequenceT(taskEither)(perform(validatedDatas.email, this.userRepository.getByEmail, this.logger, 'get user by email'), right(validatedDatas)),
      ),
      //Check email unicity
      chain(([existingUser, validatedDatas]) => {
        if (existingUser == null) {
          return right(validatedDatas);
        }
        return left(new ConflictException('Email already exists.'));
      }),
      //Use-case process
      chain((validatedDatas) =>
        sequenceT(taskEither)(
          perform(validatedDatas.plainPassword, this.authenticationService.hashPlainPassword, this.logger, 'hash plain password'),
          right(validatedDatas),
        ),
      ),
      //Create Domain entity
      chain(([hashedPassword, validatedDatas]) =>
        fromUnknown(
          {
            id: validatedDatas.id,
            email: validatedDatas.email,
            password: hashedPassword,
          },
          User,
          this.logger,
          'user',
        ),
      ),
      //Store entity
      chain((user) => sequenceT(taskEither)(perform(user, this.userRepository.save, this.logger, 'save user in storage system.'), right(user))),
      //Emit domain event
      chain(() =>
        perform(
          //TODO: Refactor: email should be the one from validated datas. Prepare domain event before storing user, then emit event.
          { eventKey: USER_CREATED, payload: { email: email } },
          this.domainEventPublisher.publishEvent,
          this.logger,
          'emit user created event.',
        ),
      ),
      map(noop),
    );
    return executeTask(task);
  }
}

const noop = () => {};
